#!/usr/bin/env node
/* OAuth 1.0a 署名の自己検査。  node ingest/test-oauth.mjs

   署名が1バイトでも狂うと、X からは 401 が返るだけで理由が分からない。
   夜中の cron で静かに壊れるのがいちばん困るので、ここで確かめておく。

   検証値について：
     X の公式ドキュメントに載っている署名例は、同じページに載っている
     署名ベース文字列と噛み合っていない（既知の誤り）。
     そこで独立実装（npm の oauth-1.0a）と突き合わせて確定させた値を使う。
     ベース文字列のほうは公式の記載と1バイトも違わないことも確認済み。
*/
import crypto from 'node:crypto';

process.env.X_API_KEY       = 'xvz1evFS4wEEPTGEFPHBog';
process.env.X_API_SECRET    = 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw';
process.env.X_ACCESS_TOKEN  = '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb';
process.env.X_ACCESS_SECRET = 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE';

const realBytes = crypto.randomBytes, realNow = Date.now;
crypto.randomBytes = () => ({ toString: () => 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg' });
Date.now = () => 1318622958 * 1000;

const { oauth1Header } = await import('./x-auth.mjs');
const header = oauth1Header('POST', 'https://api.twitter.com/1.1/statuses/update.json', {
  status: 'Hello Ladies + Add Users to a Group',
  include_entities: 'true',
});

crypto.randomBytes = realBytes; Date.now = realNow;

const got  = decodeURIComponent(/oauth_signature="([^"]+)"/.exec(header)[1]);
const want = 'kVtz2eHt7gqfU7ThxrFvWqUeLZo=';
const ok   = got === want;

console.log('署名 得た :', got);
console.log('署名 期待 :', want);
console.log(ok ? '✅ OAuth 1.0a の署名は正しい'
               : '❌ 署名が合わない。X からは 401 が返るだけで理由が出ないので、ここで止めること');
process.exit(ok ? 0 : 1);
