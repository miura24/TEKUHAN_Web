# テク班 活動お知らせ PWA — 最終実装メモ

## システム全体構成

```
manga-circle-pwa/
├── index.html        # メインUI + Firebase FCM 購読ロジック
├── manifest.json     # PWAマニフェスト（スタンドアロン表示・アイコン定義）
├── sw.js             # Service Worker（キャッシュ + FCMバックグラウンド受信）
├── Code.gs           # GAS WebApp（活動情報取得・FCMトークン管理・プッシュ通知送信）
├── icons/
│   ├── icon-192.png  # ★ 別途用意が必要（192×192px）
│   └── icon-512.png  # ★ 別途用意が必要（512×512px）
└── README.md
```

## アーキテクチャ概要

システム内には「活動情報・トークン登録フロー」と「通知送信フロー」の2方向がある。

```
【活動情報・トークン登録フロー（ブラウザ → GAS）】
[ユーザーのブラウザ（PWA）]
        │  fetch (GET / POST)
        ▼
[Google Apps Script (GAS) WebApp]
        │  SpreadsheetApp
        ▼
[Google スプレッドシート]
  ├── 教室データシート  （A:ID, B:活動日, C:教室名）
  ├── 資料データシート  （A:ID, B:活動日, C:Google Drive URL）
  └── Subscribersシート （A:FCMトークン）

【通知送信フロー（GAS → FCM → ブラウザ）】
[Google Apps Script (GAS) WebApp]
        │  HTTP v1 API + OAuth2 Bearer
        ▼
[Firebase Cloud Messaging (FCM)]
        │  プッシュ通知配信
        ▼
[ユーザーのブラウザ（PWA）/ sw.js]
```

---

## ファイル別の責務

### `index.html`

| 処理 | 詳細 |
|---|---|
| Firebase 初期化 | `firebase.initializeApp(CONFIG.FIREBASE_CONFIG)` |
| SW 登録 | `navigator.serviceWorker.register('./sw.js')` |
| FCMトークン取得 | `messaging.getToken({ vapidKey, serviceWorkerRegistration })` |
| トークン送信 | GAS doPost に `action:'subscribe'` で POST |
| 活動情報取得 | GAS doGet に `?action=getLatest` で GET |
| Drive URL変換 | `/file/d/【ID】/` → `thumbnail?id=【ID】&sz=w1000` |
| フォアグラウンド受信 | `messaging.onMessage()` → トーストと `Notification` API |
| 備考表示 | GAS レスポンスの `url` が有効なら「資料あり」、なければ「資料なし」を活動カードに表示 |
| 通知停止 | `messaging.deleteToken()` → GAS doPost `action:'unsubscribe'` |

**設定値（`CONFIG` オブジェクト）**

```js
const CONFIG = {
  GAS_ENDPOINT:    'https://script.google.com/macros/s/...../exec',
  FIREBASE_CONFIG: { apiKey, authDomain, projectId, ... },
  VAPID_PUBLIC_KEY: 'BE6v...',  // Firebase Console > Cloud Messaging > ウェブプッシュ証明書
};
```

> ⚠️ `VAPID_PUBLIC_KEY` と `FIREBASE_CONFIG` の `apiKey` はクライアントサイドに露出する。
> Firebase Security Rules と許可ドメイン設定（Firebase Console > Authentication > 承認済みドメイン）で不正利用を防ぐこと。

---

### `sw.js`

| 処理 | 詳細 |
|---|---|
| Firebase SDK 読み込み | `importScripts(firebase-app-compat / firebase-messaging-compat)` |
| Firebase 初期化 | `index.html` と**同じ** `firebaseConfig` を使用（必須） |
| バックグラウンド受信 | `messaging.onBackgroundMessage()` を登録。通知の自動表示は FCM SDK に委ねる（後述） |
| キャッシュ戦略 | Cache First（静的アセットのみ）。FCM / GAS / Drive はキャッシュ対象外 |
| 通知クリック | `notificationclick` → PWAウィンドウを前面に出す or 新規タブで開く |
| キャッシュバージョン | `CACHE_NAME = 'tekuban-v3'`（更新時はここをインクリメント） |

> **`showNotification()` をコメントアウトしている理由**
> FCM に `notification` フィールドを含むメッセージを送ると、Firebase SDK（または OS）が**自動で**通知を1回表示する。
> `onBackgroundMessage` ハンドラ内でさらに `showNotification()` を手動で呼ぶと通知が**2回表示**されるため、意図的にコメントアウトしてある。
> `data` フィールドのみのサイレントプッシュに切り替えた場合は、コメントアウトを外して手動表示に戻すこと。

> **FCMとSWの関係**
> Firebase Messaging SDK は `serviceWorkerRegistration` オプションで任意の SW を指定できる（v9）。
> `firebase-messaging-sw.js` という固定名でのファイル配置は**不要**。

---

### `Code.gs`（GAS WebApp）

| 関数 | 種別 | 処理 |
|---|---|---|
| `doGet(e)` | HTTPハンドラ | `?action=getLatest` → `getLatestActivity()` |
| `doPost(e)` | HTTPハンドラ | `action:'subscribe'` → `saveFcmToken()` / `action:'unsubscribe'` → 受付のみ |
| `findNextActivity()` | ビジネスロジック | 教室データから今日以降で最初の活動日を検索 → 資料データから同日のURLを照合。`getLatestActivity()` と `sendPushNotification()` の両方から呼ばれる共通関数 |
| `getLatestActivity()` | doGet用ラッパー | `findNextActivity()` の結果を `{ date, room, url }` 形式に整形してレスポンスを返す |
| `saveFcmToken(token)` | DB操作 | Subscribers シートへの形式チェック・重複チェック・件数上限（`MAX_SUBSCRIBERS`）付き追記 |
| `sendPushNotification()` | 通知送信（手動/トリガー） | 全トークンへ FCM HTTP v1 API 経由で一斉送信。ループ後にまとめて無効トークンを削除 |
| `getFcmAccessToken()` | 認証 | スクリプトプロパティから読んだサービスアカウント秘密鍵でJWTを生成 → OAuth2トークンを取得 |
| `sendToSingleToken()` | FCM送信 | 1トークンへのメッセージ送信 + 無効トークン判定（`UNREGISTERED` / `NOT_FOUND` のみ削除対象） |
| `deleteInvalidTokens()` | DB操作 | 後ろ行から削除して行番号ずれを防止 |
| `getAllFcmTokens()` | DB操作 | Subscribers シートの全トークンを配列で返す |
| `toDateString(date)` | ヘルパー | `Date` を `yyyy/MM/dd` 文字列に変換（`Utilities.formatDate()` 使用、スクリプトのタイムゾーン基準） |
| `buildResponse(payload)` | ヘルパー | JSON レスポンスオブジェクトを生成 |
| `checkNextActivity()` | 動作確認用 | 通知を送らずに次の活動情報とアクセストークン取得を確認する。本番通知を飛ばしたくない場合はこちらを使う |

**日付照合の注意点**（バグ修正済み）

`findNextActivity()` では `new Date()` 同士の `.getTime()` 比較ではなく、
`toDateString()`（内部で `Utilities.formatDate()` を使用）で `yyyy/MM/dd` 文字列にそろえてから比較している。
スプレッドシートのセル値がタイムゾーンや時刻付きで取り込まれる場合でも日付の一致を確実に行うため。

---

## Push通知フロー（完全版）

```
init()
 ├─ registerServiceWorker()
 │    └─ navigator.serviceWorker.register('./sw.js')
 ├─ loadActivityInfo()
 │    └─ fetch(GAS_ENDPOINT + '?action=getLatest')
 │         └─ 教室データ + 資料データを照合 → { date, room, url }
 │              └─ Drive URL を thumbnail 形式に変換して <img> に表示
 └─ 現在の Notification.permission を確認 → updatePushUI()

[ユーザーが「通知を許可する」をタップ]
 └─ subscribeToPush()
      ├─ Notification.requestPermission()
      ├─ messaging.getToken({ vapidKey, serviceWorkerRegistration })
      ├─ fetch(GAS_ENDPOINT, POST, { action:'subscribe', fcmToken })
      │    └─ GAS saveFcmToken() → Subscribers シートへ追記
      ├─ updatePushUI('granted')
      └─ messaging.onMessage() → フォアグラウンド受信ハンドラ登録

[GASトリガーで毎週実行]
 └─ sendPushNotification()
      ├─ findNextActivity() で今日以降の直近の活動を特定
      ├─ getFcmAccessToken()（サービスアカウントJWT → OAuth2）
      └─ 全Subscribersへ FCM HTTP v1 API で送信
           └─ UNREGISTERED / NOT_FOUND → 全送信後にまとめて Subscribersシートから削除

[バックグラウンドでFCM受信]
 └─ sw.js: messaging.onBackgroundMessage()
      └─ FCM SDK が notification フィールドを読んで自動で通知を表示
           └─ notificationclick → PWAを前面に表示
```

---

## スプレッドシート構成

### 教室データシート

| 列 | 内容 | 例 |
|---|---|---|
| A | ID（連番等） | 1 |
| B | 活動日 | 2026/06/22 |
| C | 教室名 | 共通教育棟 B201 |

### 資料データシート

| 列 | 内容 | 例 |
|---|---|---|
| A | ID（連番等） | 1 |
| B | 活動日 | 2026/06/22 |
| C | Google Drive URL | https://drive.google.com/file/d/xxxx/view |

### Subscribersシート

| 列 | 内容 |
|---|---|
| A | FCMトークン（ヘッダー行: `token`） |

---

## セットアップ手順（初回・再構築時）

### 1. アイコン画像の用意

`icons/icon-192.png`（192×192px）と `icons/icon-512.png`（512×512px）を作成して配置する。
[RealFaviconGenerator](https://realfavicongenerator.net/) を使うと簡単。

### 2. Firebase プロジェクト確認

- プロジェクト ID: `auto-notification-for-tekuhan`
- VAPID 公開鍵: Firebase Console > プロジェクトの設定 > Cloud Messaging > ウェブプッシュ証明書
- `index.html` の `CONFIG.VAPID_PUBLIC_KEY` と `sw.js` の `firebase.initializeApp()` に設定済み

### 3. サービスアカウントの設定

サービスアカウントの秘密鍵は**コードには書かず**、GAS のスクリプトプロパティに保存する。

Apps Script エディタ > プロジェクトの設定 > スクリプト プロパティ から以下の2項目を追加する。

| プロパティ名 | 値 |
|---|---|
| `SA_CLIENT_EMAIL` | サービスアカウントのメールアドレス（例: `xxx@xxx.iam.gserviceaccount.com`） |
| `SA_PRIVATE_KEY` | JSON キーの `private_key` の値（`-----BEGIN PRIVATE KEY-----` から末尾まで） |

- ロール: `Firebase Cloud Messaging 管理者（roles/cloudmessaging.admin）`

> ⚠️ `SA_PRIVATE_KEY` は絶対に GitHub に Push しないこと。`Code.gs` はスクリプトプロパティから読む実装になっているため、鍵をコードに書く必要はない。鍵を作り直したときはスクリプトプロパティの値を書き換えるだけでよい。

### 4. GAS デプロイ設定

- 種類: **ウェブアプリ**
- 実行ユーザー: **自分**
- アクセスできるユーザー: **全員（匿名ユーザーを含む）**
- `doPost` を変更した場合は**必ず新バージョンとして再デプロイ**すること

### 5. GAS トリガー設定（通知の自動送信）

Apps Script エディタ > トリガー から以下を設定する。

| 関数 | イベント | 推奨タイミング |
|---|---|---|
| `sendPushNotification` | 時間主導型（週ベースのタイマー） | 活動曜日の朝（例: 日曜 9:00）|

---

## ローカル動作確認

Service Worker と Push API は **HTTPS** または `localhost` でのみ動作する。

```bash
# Node.js がある場合
npx serve .

# Python の場合
python -m http.server 8080
```

`http://localhost:8080` で開いて確認する。

## 動作チェックリスト

- [ ] `localhost` または GitHub Pages (HTTPS) で開く
- [ ] DevTools > Application > Service Workers に `sw.js` が登録される
- [ ] DevTools > Application > Manifest にアイコン・名前が表示される
- [ ] 「通知を許可する」ボタンを押すとブラウザのダイアログが出る
- [ ] 許可後にバッジが「通知オン」になる
- [ ] GASのコンソールで `checkNextActivity()` を実行してエラーがないことを確認する
- [ ] GASのコンソールで `sendPushNotification()` を手動実行 → 通知が届く（**登録者全員に本番通知が飛ぶので注意**）
- [ ] アプリを閉じた状態でも通知が届く（バックグラウンド受信）
- [ ] 通知タップでPWAが前面に開く
- [ ] 「通知を停止する」でバッジが「通知オフ」になる

---

## トラブルシューティング

### 通知が届かない

1. `Notification.permission` が `granted` になっているか確認（DevTools > Console）
2. GAS の `checkNextActivity()` を実行してスプレッドシートとアクセストークンの取得を確認
3. GAS の `sendPushNotification()` を手動実行してコンソールログを確認
4. Subscribers シートにトークンが保存されているか確認
5. Firebase Console > Cloud Messaging でプロジェクトが有効か確認

### 資料画像が表示されない

1. Google Drive の共有設定が「リンクを知っている全員が閲覧可」になっているか確認
2. Drive URL が `/file/d/【ID】/view` 形式か確認（`convertDriveUrl()` で変換される）
3. DevTools > Network タブで `thumbnail?id=...` リクエストのレスポンスを確認

### GAS doPost が 403 / CORS エラーになる

- `Content-Type: text/plain` を使っている（`application/json` はプリフライトが発生するため意図的に回避）
- `redirect: 'follow'` が指定されているか確認（GAS は 302 リダイレクトを返す）
- GAS のデプロイが「全員（匿名ユーザーを含む）」になっているか確認

### 日付が一致せず活動情報が取得できない

- `findNextActivity()` 内で `toDateString()`（`Utilities.formatDate()` ベース）による文字列比較を使用済み
- スプレッドシートの日付列のセル書式が「日付」になっているか確認
- GAS のタイムゾーン設定（スクリプトの設定 > タイムゾーン）が `Asia/Tokyo` になっているか確認

### SW が古いキャッシュを返す

- `sw.js` の `CACHE_NAME`（現在: `tekuban-v3`）をインクリメントしてデプロイする
- DevTools > Application > Storage > Clear site data で強制クリアできる

---

## 既知の仕様・制約

- **iOS Safari**: Web Push は iOS 16.4以降の Safari / Chrome for iOS でのみ動作する。ホーム画面に追加（A2HS）した場合のみ通知が届く
- **バックグラウンド受信**: FCM に `notification` フィールドを含むメッセージを送ると、Firebase SDK が自動で通知を1回表示する。`sw.js` の `onBackgroundMessage` ハンドラ内で `showNotification()` を手動で呼ぶと通知が**2回表示**されるため、意図的にコメントアウトしてある
- **トークン削除時の GAS 連携**: `messaging.deleteToken()` 後はトークンを取得できないため、GAS側の削除は即時行わず、次回送信時に `UNREGISTERED` エラーで自然削除される設計
- **同時購読デバイス数**: 上限 300（`MAX_SUBSCRIBERS` 定数で設定）。GAS の実行時間制限（6分/回）に注意

---

## 更新履歴

| バージョン | 変更内容 |
|---|---|
| Step 1 | 基本PWA構成・Web Push購読（VAPID）・モックデータ |
| Step 2 | Firebase プロジェクト連携・FCM HTTP v1 API対応 |
| Step 3 | GAS WebApp 連携・スプレッドシートからの活動情報取得 |
| Step 3.5 | doPost 追加・FCMトークン管理（Subscribers シート） |
| Step 4 | デザイン刷新（グリーンテーマ）・Drive画像表示・フォアグラウンド受信 |
| **Final** | 日付照合バグ修正（文字列比較化）・キャッシュv3・README最終化 |
| **Final+** | Code.gs 全面書き換え（findNextActivity共通化・スクリプトプロパティ化・saveFcmToken強化）・README更新 |
