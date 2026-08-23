/* ============================================================================
   Instagram の @メンションを受けて、GitHub の workflow を叩く受け口
   ----------------------------------------------------------------------------
   Cloudflare Workers の無料枠に置けます（月10万リクエストまで無料）。

   Instagram はハッシュタグ検索で投稿者名を返さないため、
   タグだけの投稿は全部 0000 号に落ちます。@メンションだけが名を運びます。
   だからこの受け口が Instagram 側の唯一の経路です。

   環境変数
     IG_VERIFY_TOKEN  Meta の webhook 登録時に自分で決める文字列
     IG_APP_SECRET    Meta アプリのシークレット（署名検証に必須）
     IG_TOKEN         Instagram Graph API のアクセストークン（本文・画像・投稿者名の取得用）
     GH_TOKEN         repo スコープの Personal Access Token
     GH_REPO          "owner/repo"
   ============================================================================ */

const enc = new TextEncoder();

/* X-Hub-Signature-256 の検証。
   これが無いと、URL を知った誰でも観測を捏造して投げ込めます。本番では必須。
   timingSafeEqual が無い環境なので、長さを揃えた定数時間比較を自前で書いています。 */
async function verify(secret, raw, header){
  if(!secret || !header) return false;
  const sent = String(header).replace(/^sha256=/, '');
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, raw);
  const mine = [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(mine.length !== sent.length) return false;
  let diff = 0;
  for(let i=0; i<mine.length; i++) diff |= mine.charCodeAt(i) ^ sent.charCodeAt(i);
  return diff === 0;
}

/* webhook は media_id しか渡してこない。
   ここで本文・画像・投稿者名まで引いておかないと、盤では 0000 号になります。
   media_url は署名付きで期限切れするので、permalink も必ず一緒に渡します。 */
async function lookup(mediaId, token){
  if(!token) return { id: mediaId };
  try{
    const f = 'id,caption,media_url,permalink,timestamp,username,media_type';
    const r = await fetch(`https://graph.instagram.com/${mediaId}?fields=${f}&access_token=${token}`);
    if(!r.ok) return { id: mediaId };
    const j = await r.json();
    return { id:j.id || mediaId, caption:j.caption || '', media_url:j.media_url || null,
             permalink:j.permalink || null, timestamp:j.timestamp || null,
             username:j.username || null };
  }catch{ return { id: mediaId }; }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // 登録時の疎通確認
    if (req.method === 'GET') {
      const p = url.searchParams;
      if (p.get('hub.verify_token') === env.IG_VERIFY_TOKEN) {
        return new Response(p.get('hub.challenge'), { status: 200 });
      }
      return new Response('forbidden', { status: 403 });
    }
    if (req.method !== 'POST') return new Response('method', { status: 405 });

    // 署名検証。生のバイト列に対して検証するので、JSON にする前に読む。
    const raw = await req.arrayBuffer();
    const ok = await verify(env.IG_APP_SECRET, raw, req.headers.get('X-Hub-Signature-256'));
    if (!ok) return new Response('bad signature', { status: 401 });

    let body;
    try { body = JSON.parse(new TextDecoder().decode(raw)); }
    catch { return new Response('bad json', { status: 400 }); }

    const items = [];
    for (const entry of body.entry || []) {
      for (const ch of entry.changes || []) {
        if (ch.field !== 'mentions') continue;
        const v = ch.value || {};
        if (!v.media_id) continue;
        items.push(await lookup(v.media_id, env.IG_TOKEN));
      }
    }
    if (!items.length) return new Response('ok', { status: 200 });

    // 現像は六時間ごとだが、メンションは push なので即座に待ち行列へ積む。
    // 実際に観測になるのは次の現像のとき——遅いことは仕様。
    await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'kansoku',
      },
      body: JSON.stringify({ event_type: 'instagram-mention', client_payload: { items } }),
    });
    return new Response('ok', { status: 200 });
  },
};
