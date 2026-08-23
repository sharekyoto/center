/* ============================================================================
   X への書き込み認証
   ----------------------------------------------------------------------------
   検索（読み取り）は app-only の bearer で足りるが、
   投稿・返信・引用・メディア添付は user context の認証が要る。ここが最初の関門。

   二つの道があり、既定は 1 を使う。

   1) OAuth 1.0a （推奨・既定）
      access token に有効期限が無い。secrets に4つ入れたら、あとは放っておける。
      この企画は「人的リソースが無いので自走させる」が前提なので、こちらが正しい。
      X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET

   2) OAuth 2.0 user context （X_USER_TOKEN だけ渡された場合の代替）
      アクセストークンが約2時間で切れる。GitHub Actions から自動更新するには
      refresh token を書き戻す仕組みが要り、cron で回す形とは相性が悪い。
      手で試すとき用と考えたほうがいい。
   ============================================================================ */

import crypto from 'node:crypto';

/* RFC 3986。encodeURIComponent が残す ! ' ( ) * も落とす */
const enc = s => encodeURIComponent(String(s))
  .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export const hasOAuth1 = () => !!(process.env.X_API_KEY && process.env.X_API_SECRET
                               && process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_SECRET);
export const hasOAuth2 = () => !!process.env.X_USER_TOKEN;
export const canWrite  = () => hasOAuth1() || hasOAuth2();

/* 署名。body が JSON でも multipart でも、署名対象に入るのは
   oauth_* と URL のクエリだけ（本文が form-urlencoded のときだけ本文も入る）。 */
export function oauth1Header(method, url, extra = {}){
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: process.env.X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: process.env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  const all = { ...oauth, ...extra };
  for (const [k, v] of u.searchParams) all[k] = v;

  const paramStr = Object.keys(all).sort().map(k => enc(k) + '=' + enc(all[k])).join('&');
  const baseStr  = [method.toUpperCase(), enc(u.origin + u.pathname), enc(paramStr)].join('&');
  const key      = enc(process.env.X_API_SECRET) + '&' + enc(process.env.X_ACCESS_SECRET);
  oauth.oauth_signature = crypto.createHmac('sha1', key).update(baseStr).digest('base64');

  return 'OAuth ' + Object.keys(oauth).sort()
    .map(k => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
}

/* 書き込み用の Authorization ヘッダを1本返す。呼ぶ側は方式を意識しない。 */
export function writeAuth(method, url){
  if (hasOAuth1()) return oauth1Header(method, url);
  if (hasOAuth2()) return `Bearer ${process.env.X_USER_TOKEN}`;
  return null;
}
