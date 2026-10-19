/**
 * Code.gs — テク班 活動お知らせ GAS WebApp（FCM HTTP v1 API）
 *
 * 【役割】
 *   doGet  : アプリに直近の活動情報（日付・教室・資料URL）を返す
 *   doPost : アプリから送られた FCM トークンを Subscribers シートに登録する
 *   sendPushNotification : 毎週のトリガーから呼ばれ、登録済みの全端末に通知を送る
 *
 * 【デプロイ】
 *   1. 「デプロイ」→「デプロイを管理」→ 鉛筆アイコン → バージョン「新バージョン」でデプロイ
 *   2. 種類: ウェブアプリ / 実行ユーザー: 自分 / アクセスできるユーザー: 全員（匿名ユーザーを含む）
 *   ※ doGet・doPost はデプロイ済みの版で動く。コードを変えたら必ず新バージョンで再デプロイする
 *   ※ sendPushNotification（トリガー実行）は保存済みの最新コードで動く
 *
 * 【スプレッドシート構成】（1行目はすべてヘッダー）
 *   教室データ  : B=活動日, C=教室名
 *   資料データ  : B=活動日, C=資料URL（Google Drive）
 *   Subscribers : A=FCMトークン（ヘッダー "token"）
 *
 * 【サービスアカウントの鍵】
 *   鍵はコードに書かず、スクリプトプロパティに置く（プロジェクトの設定 > スクリプト プロパティ）
 *     SA_CLIENT_EMAIL : サービスアカウントのメールアドレス
 *     SA_PRIVATE_KEY  : JSONキーの private_key の値（-----BEGIN PRIVATE KEY----- から末尾まで）
 *   鍵を作り直したときは SA_PRIVATE_KEY を書き換えるだけでよい
 *
 * 【手動実行の注意】
 *   sendPushNotification をエディタから実行すると、登録者全員に本番の通知が飛ぶ。
 *   動作確認には checkNextActivity（通知を送らない）を使う。
 */

// ════════════════════════════════════════════════════════════════════
// 設定値
// ════════════════════════════════════════════════════════════════════

/** スプレッドシートID（URLの /d/〜/edit の間の文字列） */
const SPREADSHEET_ID = '1-Bb0e5POYDJ5pZV1zniHO3ztL6rVKV3AZCcVhjCUiBo';

/** シート名 */
const SHEET_ROOMS       = '教室データ';
const SHEET_MATERIALS   = '資料データ';
const SHEET_SUBSCRIBERS = 'Subscribers';

/** Firebase プロジェクトID */
const FIREBASE_PROJECT_ID = 'auto-notification-for-tekuhan';

/** Subscribers シートに保存するトークン数の上限（部員数より十分大きい値） */
const MAX_SUBSCRIBERS = 300;

/** FCM トークンの形式（英数字と : - _ のみ、100〜300字程度） */
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_\-:]{100,300}$/;

/** 資料URLが未登録のときに表示する文言 */
const MATERIAL_PLACEHOLDER = '準備中（担当者に確認してください）';

// サービスアカウントの認証情報はスクリプトプロパティから読む（コードに鍵を置かない）
const SCRIPT_PROPS = PropertiesService.getScriptProperties();
const SERVICE_ACCOUNT = {
  client_email: SCRIPT_PROPS.getProperty('SA_CLIENT_EMAIL'),
  // プロパティに "\n" が文字列のまま入っていても、本物の改行に戻す（戻さないと署名に失敗する）
  private_key: (SCRIPT_PROPS.getProperty('SA_PRIVATE_KEY') || '').replace(/\\n/g, '\n'),
};

// ════════════════════════════════════════════════════════════════════
// doGet — 活動情報の取得
// ════════════════════════════════════════════════════════════════════

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  try {
    if (action === 'getLatest') {
      return buildResponse(getLatestActivity());
    }
    return buildResponse({ status: 'error', message: '不明なactionです: ' + action });
  } catch (err) {
    console.error('[GAS] doGetエラー:', err);
    return buildResponse({ status: 'error', message: err.message });
  }
}

// ════════════════════════════════════════════════════════════════════
// doPost — FCMトークンの登録・解除
//
// フロントエンドから送られるJSONボディ:
//   { action: 'subscribe',   fcmToken: '...' }
//   { action: 'unsubscribe' }
// ════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    // GAS doPost のボディは e.postData.contents に生文字列で入る
    const body   = JSON.parse(e.postData.contents);
    const action = body.action || '';

    if (action === 'subscribe') {
      if (!body.fcmToken) {
        return buildResponse({ status: 'error', message: 'fcmTokenが空です' });
      }
      const result = saveFcmToken(body.fcmToken);
      return buildResponse(result);
    }

    if (action === 'unsubscribe') {
      // 解除時はトークンが送られてこないため、シートからは消さない。
      // 次回送信時に UNREGISTERED が返った時点で自動削除される。
      return buildResponse({ status: 'ok', message: '解除リクエストを受け付けました' });
    }

    return buildResponse({ status: 'error', message: '不明なactionです: ' + action });

  } catch (err) {
    console.error('[GAS] doPostエラー:', err);
    return buildResponse({ status: 'error', message: err.message });
  }
}

// ════════════════════════════════════════════════════════════════════
// 活動情報
// ════════════════════════════════════════════════════════════════════

/**
 * 今日以降で一番近い活動日と、その日の教室・資料URLを探す。
 * アプリ表示（getLatestActivity）と通知（sendPushNotification）の両方がこれを使う。
 * 以前は2か所に同じ処理があり、片方だけ日付比較の修正が漏れていたため共通化した。
 *
 * @returns {{ date: Date, room: string, url: string } | null} 予定がなければ null
 */
function findNextActivity() {
  const ss            = SpreadsheetApp.openById(SPREADSHEET_ID);
  const roomSheet     = ss.getSheetByName(SHEET_ROOMS);
  const materialSheet = ss.getSheetByName(SHEET_MATERIALS);

  if (!roomSheet || !materialSheet) {
    throw new Error('教室データ または 資料データ のシートが見つかりません');
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 1. 教室データから、今日以降で最初の活動日を探す
  //    教室は数週間前から予約されるので、こちらを基準にする
  const roomData = roomSheet.getDataRange().getValues();
  let next = null;
  for (let i = 1; i < roomData.length; i++) {
    if (!roomData[i][1]) continue; // 空行は無視
    const activityDate = new Date(roomData[i][1]);
    if (activityDate >= today) {
      next = { date: activityDate, room: roomData[i][2] || '未定', url: MATERIAL_PLACEHOLDER };
      break;
    }
  }
  if (!next) return null;

  // 2. 同じ活動日の資料URLを資料データから探す
  //    Date の getTime() 同士で比べると、タイムゾーンや時刻付きの値でずれることがあるため、
  //    yyyy/MM/dd の文字列にそろえてから比較する
  const targetDateStr = toDateString(next.date);
  const materialData  = materialSheet.getDataRange().getValues();
  for (let i = 1; i < materialData.length; i++) {
    if (!materialData[i][1]) continue; // 空行は無視
    if (toDateString(new Date(materialData[i][1])) === targetDateStr) {
      if (materialData[i][2]) next.url = materialData[i][2];
      break;
    }
  }

  return next;
}

/**
 * アプリに返す形に整える（doGet から呼ばれる）。
 */
function getLatestActivity() {
  const next = findNextActivity();
  if (!next) {
    return { status: 'success', data: null };
  }
  return {
    status: 'success',
    data: {
      date: (next.date.getMonth() + 1) + '月' + next.date.getDate() + '日',
      room: next.room,
      url:  next.url,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// FCMトークンの登録
// ════════════════════════════════════════════════════════════════════

/**
 * FCMトークンを Subscribers シートに保存する。
 * エンドポイントは誰でも叩けるため、形式チェック・重複チェック・件数上限をかける。
 *
 * @param {string} token - FCMデバイストークン
 * @returns {{ status: string, message: string }}
 */
function saveFcmToken(token) {
  // 公開エンドポイントなので、FCMトークンの形をしていない文字列は保存しない
  if (typeof token !== 'string' || !FCM_TOKEN_PATTERN.test(token)) {
    console.warn('[GAS] 不正な形式のトークンを拒否しました');
    return { status: 'error', message: 'トークンの形式が正しくありません' };
  }

  // 同時に登録が来たときに重複行ができないよう、シート操作の間はロックする
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    let   sheet = ss.getSheetByName(SHEET_SUBSCRIBERS);

    // シートがなければ作ってヘッダーを入れる
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_SUBSCRIBERS);
      sheet.appendRow(['token']);
      console.log('[GAS] Subscribersシートを新規作成しました');
    }

    const existingTokens = getAllFcmTokens();

    if (existingTokens.includes(token)) {
      console.log('[GAS] トークン重複のためスキップ');
      return { status: 'ok', message: '登録済みです' };
    }

    // シートが際限なく伸びないよう上限を設ける
    if (existingTokens.length >= MAX_SUBSCRIBERS) {
      console.warn('[GAS] 登録数が上限に達したため保存しません');
      return { status: 'error', message: '登録数の上限に達しています。担当者に連絡してください' };
    }

    sheet.appendRow([token]);
    console.log('[GAS] トークンを保存:', token.slice(0, 20) + '…');
    return { status: 'ok', message: 'トークンを保存しました' };

  } finally {
    lock.releaseLock();
  }
}

// ════════════════════════════════════════════════════════════════════
// 通知の送信（毎週のトリガーから呼ぶ）
// ════════════════════════════════════════════════════════════════════

/**
 * 直近の活動情報を、登録済みの全端末に通知する。
 * 無効になったトークンは、全員への送信が終わってからまとめて削除する。
 *
 * ※ トリガーにはこの関数名（sendPushNotification）を設定する
 * ※ エディタから実行すると登録者全員に本番の通知が飛ぶので注意
 */
function sendPushNotification() {
  const next = findNextActivity();
  if (!next) {
    console.log('今後の教室予約がないため、通知をスキップしました');
    return;
  }

  const title = `【テク班】${next.date.getMonth() + 1}/${next.date.getDate()} の活動お知らせ`;
  const body  = `教室: ${next.room}\n資料: ${next.url}\n確認よろしくお願いします！`;

  const tokens = getAllFcmTokens();
  if (tokens.length === 0) {
    console.log('登録済みの端末がないため、通知をスキップしました');
    return;
  }

  const accessToken = getFcmAccessToken();

  let successCount = 0;
  const invalidTokens = [];

  for (const fcmToken of tokens) {
    try {
      const result = sendToSingleToken(fcmToken, title, body, accessToken);
      if (result.success) {
        successCount++;
      } else if (result.shouldDelete) {
        invalidTokens.push(fcmToken);
      }
    } catch (err) {
      console.error('[GAS] 送信エラー:', err);
    }
  }

  // ループ中に行を消すと、シートの行番号とメモリ上の配列がずれて
  // 有効なトークンまで消してしまうため、削除は最後にまとめて行う
  if (invalidTokens.length > 0) {
    deleteInvalidTokens(invalidTokens);
  }

  console.log(`${successCount} / ${tokens.length} 件の端末に送信しました（無効トークン削除: ${invalidTokens.length} 件）`);
}

// ════════════════════════════════════════════════════════════════════
// FCM HTTP v1 API ヘルパー
// ════════════════════════════════════════════════════════════════════

/**
 * サービスアカウントの鍵で JWT を作り、Google の OAuth2 エンドポイントから
 * FCM 用のアクセストークンを取得する。
 *
 * FCM HTTP v1 API は Bearer トークン認証が必須。
 * GAS 標準の ScriptApp.getOAuthToken() は FCM のスコープを持たず、
 * Firebase Admin SDK も GAS では使えないため、JWT を自前で生成している。
 *
 * @returns {string} アクセストークン
 */
function getFcmAccessToken() {
  if (!SERVICE_ACCOUNT.client_email || !SERVICE_ACCOUNT.private_key) {
    throw new Error('スクリプトプロパティに SA_CLIENT_EMAIL / SA_PRIVATE_KEY が設定されていません');
  }

  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss:   SERVICE_ACCOUNT.client_email,                           // 発行者 = サービスアカウント
    scope: 'https://www.googleapis.com/auth/firebase.messaging',  // FCM 送信のスコープ
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,                                             // 1時間有効
  };

  // Base64URL エンコード（末尾の = は JWT では付けない）
  const encodeB64Url = (obj) =>
    Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');

  const signingInput = `${encodeB64Url(header)}.${encodeB64Url(claims)}`;

  // RS256 署名（鍵の改行は SERVICE_ACCOUNT を読む時点で戻してある）
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(signingInput, SERVICE_ACCOUNT.private_key)
  ).replace(/=+$/, '');

  const jwt = `${signingInput}.${signature}`;

  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method:  'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    },
    muteHttpExceptions: true,
  });

  const json = JSON.parse(res.getContentText());
  if (!json.access_token) {
    // レスポンス全文には鍵は含まれないが、ログには要点だけ残す
    throw new Error('アクセストークン取得失敗: ' + (json.error_description || json.error || res.getResponseCode()));
  }
  return json.access_token;
}

/**
 * FCM HTTP v1 API で1台の端末に通知を送る。
 *
 * @param {string} fcmToken    - 送信先の FCM トークン
 * @param {string} title       - 通知タイトル
 * @param {string} body        - 通知本文
 * @param {string} accessToken - OAuth2 アクセストークン
 * @returns {{ success: boolean, shouldDelete: boolean }}
 */
function sendToSingleToken(fcmToken, title, body, accessToken) {
  const endpoint = `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`;

  // sw.js の onBackgroundMessage が notification.title / body を読んで表示する
  const message = {
    message: {
      token: fcmToken,
      notification: { title, body },
    },
  };

  const res = UrlFetchApp.fetch(endpoint, {
    method:      'post',
    contentType: 'application/json',
    headers:     { Authorization: `Bearer ${accessToken}` },
    payload:     JSON.stringify(message),
    muteHttpExceptions: true, // エラー時も例外にせずレスポンスを受け取る
  });

  if (res.getResponseCode() === 200) {
    return { success: true, shouldDelete: false };
  }

  const resText = res.getContentText();
  console.warn(`[GAS] 送信失敗 (${res.getResponseCode()}): ${resText}`);

  // 削除するのは「端末側でトークンが無効になった」と確定できる場合だけ。
  // INVALID_ARGUMENT はメッセージ内容の不備でも返るため、これで消すと
  // 送信側のミス1つで全員のトークンが消える。削除対象にしない。
  let shouldDelete = false;
  try {
    const err       = JSON.parse(resText).error || {};
    const errorCode = (err.details && err.details[0] && err.details[0].errorCode) || '';
    shouldDelete = errorCode === 'UNREGISTERED' || err.status === 'NOT_FOUND';
  } catch (_) {
    // JSON でなければ判定せず、消さない
  }

  return { success: false, shouldDelete };
}

// ════════════════════════════════════════════════════════════════════
// Subscribers シート操作
// ════════════════════════════════════════════════════════════════════

/**
 * Subscribers シートの全トークンを返す。
 * @returns {string[]}
 */
function getAllFcmTokens() {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_SUBSCRIBERS);
  if (!sheet || sheet.getLastRow() < 2) return [];

  return sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 1)
    .getValues()
    .map(row => row[0])
    .filter(token => typeof token === 'string' && token.length > 0);
}

/**
 * 無効なトークンを Subscribers シートから削除する。
 * 後ろの行から消すことで、削除による行番号のずれを防ぐ。
 *
 * @param {string[]} invalidTokens - 削除するトークン
 */
function deleteInvalidTokens(invalidTokens) {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_SUBSCRIBERS);
  if (!sheet || sheet.getLastRow() < 2) return;

  const allTokens = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();

  for (let i = allTokens.length - 1; i >= 0; i--) {
    if (invalidTokens.includes(allTokens[i][0])) {
      sheet.deleteRow(i + 2); // +2 = ヘッダー行 + 0始まりの補正
      console.log('[GAS] 無効トークンを削除:', String(allTokens[i][0]).slice(0, 20) + '…');
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// 共通ヘルパー
// ════════════════════════════════════════════════════════════════════

/** Date を yyyy/MM/dd の文字列にする（スクリプトのタイムゾーン基準） */
function toDateString(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy/MM/dd');
}

/**
 * JSON レスポンスを生成する。
 * @param {Object} payload
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function buildResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════════════
// 動作確認用（通知は送らない）
// ════════════════════════════════════════════════════════════════════

/**
 * 次に通知される内容と、認証が通るかを確認する。
 * エディタのプルダウンでこの関数を選んで実行する。
 */
function checkNextActivity() {
  const next = findNextActivity();
  if (!next) {
    console.log('今日以降の活動予定がありません');
  } else {
    console.log(`次の活動: ${toDateString(next.date)} / 教室: ${next.room} / 資料: ${next.url}`);
  }
  console.log(`登録端末数: ${getAllFcmTokens().length}`);
  getFcmAccessToken(); // 失敗すれば例外がログに出る
  console.log('アクセストークン取得: 成功');
}