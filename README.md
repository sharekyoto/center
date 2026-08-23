# 発酵都市観測センター ── 取り込み

盤（地図）は **https://mayshare.chu.jp/center/** にあります。
このリポジトリは、その盤に流し込む **データを作る側**です。

SNS の投稿を六時間ごとに拾い、`data/feed.json` に積み、盤がそれを読みます。

```
X / Threads / Instagram          このリポジトリ                mayshare.chu.jp
 @alembicity への投稿    ──→  ingest/observe.mjs   ──→  data/feed.json  ──→  盤
                              （GitHub Actions）        （GitHub Pages）
```

---

## 中身

| | |
|---|---|
| `ingest/observe.mjs` | 本体。拾う・数える・盤を割る・返信する |
| `ingest/board.mjs` | 座標の規則。**盤側の同名の関数と一致させること** |
| `ingest/x-auth.mjs` | X への書き込み認証（OAuth 1.0a） |
| `ingest/contact.mjs` | フィルム片・一葉の画像を組む |
| `ingest/test-oauth.mjs` | 署名の自己検査。`node ingest/test-oauth.mjs` |
| `ingest/instagram-webhook.js` | Instagram の受け口（任意） |
| `ingest/README.md` | **運用の手引き。迷ったらこれ** |
| `.github/workflows/observe.yml` | 六時間ごと（JST 06 ／ 12 ／ 18 ／ 24） |

`data/` は Actions が自分で作ります。手で置かないでください。

---

## 動かすまで

### 1. secrets を入れる

Settings → Secrets and variables → Actions → **Secrets** タブ →
New repository secret を六回。

| 名前 | X Developer Portal のどこか |
|---|---|
| `X_BEARER` | Keys and tokens → Bearer Token |
| `X_API_KEY` | Consumer Keys → API Key |
| `X_API_SECRET` | Consumer Keys → API Key Secret |
| `X_ACCESS_TOKEN` | Access Token and Secret |
| `X_ACCESS_SECRET` | Access Token and Secret |
| `THREADS_TOKEN` | 任意。無くても X だけで回ります |

**Access Token は「Read and Write」で作り直してください。**
Read のみで発行された古いトークンでは投稿できません
（401 が返るだけで、理由は出ません）。

### 2. 署名を確かめる

```
node ingest/test-oauth.mjs
```

`✅` が出れば OAuth 1.0a の署名は正しく組めています。
ここで落ちるものは本番でも必ず落ちます。

### 3. 空回しで確かめる

`DRY_RUN = 1`（Variables）が入れてあります。
**この間、X には一切書き込みません。** 何を投げるつもりだったかがログに出るだけです。

Actions → 観測 → Run workflow で手で回し、ログを読んでください。

### 4. 本番にする

`DRY_RUN` を `0` にするか、変数ごと消す。

### 5. 盤につなぐ

`index.html` の `CONFIG.INGEST.FEED` を書き換えて、FTP で置き直す。

```js
INGEST:{ FEED:'https://sharekyoto.github.io/center/data/feed.json' }
```

---

## 費用

**約 $3.30／月（¥600以内）。** 内訳は `ingest/README.md` の「4. 周期と費用」。

**費用が人数で増えません。** 観測が10件でも1000件でも、現像ごとの投稿は1本です。

- **支出上限を必ず設定してください。** $20 入れておけば暴走しても止まります
- **投稿に URL を入れない。** リンク入りは約13倍、しかも伸びが落ちます
- 単価は実測報告からの推定です。**最初の1か月は請求を毎週見てください**

---

## 気をつけること

- **`ingest/board.mjs` と盤側の座標関数は同じでなければなりません。**
  片方だけ直すと `E6f3` が去年と違う場所を指します
- 生まれた盤は `data/boards-pending.json` に**名前なし**で入ります。命名は人の仕事です。
  名が付くまで、その盤の観測に座標は配られません
- `#再掲不可` ／ `#norelay` の付いた投稿は、フィルム片にも一葉にも焼きません
- **削るなら巡回の回数です。フィルム片と一葉は削らないでください。**
  そこが「引用でバズる」経路の実体なので、削ると企画の中心が消えます
