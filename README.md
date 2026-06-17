# テク班 活動お知らせ PWA — Step 1 実装メモ

## ファイル構成

```
manga-circle-pwa/
├── index.html      # メインUI + Push購読ロジック
├── manifest.json   # PWAマニフェスト
├── sw.js           # Service Worker（キャッシュ + Push受信）
├── icons/
│   ├── icon-192.png   # ★ 別途用意が必要
│   └── icon-512.png   # ★ 別途用意が必要
└── README.md
```

## Step 1 完了後に必要な作業

### 1. アイコン画像の用意
`icons/icon-192.png`（192×192px）と `icons/icon-512.png`（512×512px）を作成して配置する。
[RealFaviconGenerator](https://realfavicongenerator.net/) などを使うと簡単。

### 2. Firebase プロジェクトのセットアップ（Step 2）
1. Firebase Console でプロジェクト作成
2. Cloud Messaging を有効化
3. **VAPID 公開鍵**（ウェブプッシュ証明書）を取得
4. `index.html` の `CONFIG.VAPID_PUBLIC_KEY` に貼り付ける

### 3. GAS WebアプリのURL設定（Step 3）
GASのデプロイ後、`CONFIG.GAS_ENDPOINT` に発行されたURLを貼り付ける。

## ローカルでの動作確認

Service Worker と Push API は **HTTPS** または `localhost` でのみ動作する。

```bash
# Node.js が入っている場合
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
- [ ] DevTools > Application > Push Messaging でテスト送信 → 通知が届く

## Push購読フロー（コード上の流れ）

```
init()
 └─ registerServiceWorker()     # sw.js を登録
 └─ loadActivityInfo()           # GAS から活動情報を取得（モック）
 └─ 現在の Notification.permission を確認して UI に反映

[ユーザーが「通知を許可する」をタップ]
 └─ subscribeToPush(swReg)
      └─ Notification.requestPermission()
      └─ pushManager.subscribe({ VAPID_PUBLIC_KEY })
      └─ fetch(GAS_ENDPOINT, { action: 'subscribe', subscription })
      └─ updatePushUI('granted')
```
