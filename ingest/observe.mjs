#!/usr/bin/env node
/* ============================================================================
   発酵都市観測センター ／ 取り込み
   ----------------------------------------------------------------------------
   六時間ごとに X・Threads・Instagram を巡回し、観測に変換して data/ に書き出す。
   画像は取り込まず URL を参照するだけ。

   設計の中心：
     投稿数を、投稿者数から切り離す。
     単価が分からなくても、月額が人数で増えない形にしておく。

   費用（六時間ごと＝日4回）
     巡回      日4回 × 30 = 120 read     ≈ $0.60
     束ね投稿  日4本 × 30 = 120 write    ≈ $1.80
     一葉      日1本 × 30 =  30 write    ≈ $0.45
     初回返信  月30人程度                 ≈ $0.45
                                    合計  ≈ $3.30 ／ 月
     本文に URL を入れないこと。リンク入りの投稿は約13倍になる。
   ============================================================================ */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildStrip, buildLeaf } from './contact.mjs';
import { writeAuth, canWrite, hasOAuth1 } from './x-auth.mjs';
import { COORD_RE, SEED_RE, seedKeyBounds, centerOf, deriveBoard } from './board.mjs';

const CFG = {
  TAG: '発酵都市観測',
  ACCOUNT: 'alembicity',   // X・Instagram・Threads 共通。タグでもメンションでも拾う
  SPLIT_AT: 8,
  ANON: '0000',
  WEB_FROM: 101,
  LOCAL_TO: 100,
  DIR: 'data',
  DRY: process.env.DRY_RUN === '1',

  POST: {
    reply: 'first',        // 'first'＝初回の発番だけ返す ／ 'none' ／ 'all'
    replyDailyCap: 20,     // 一日でこれを超えたら返信をやめ、束ね投稿に回す
    develop: true,         // 現像ごとに1本だけ出す。投稿数の上限は日4本
    strip: true,           // 4コマをフィルム片1枚に焼いて添付する
    leafHour: 9,           // UTC 9時＝JST 18時。一葉はいちばん読まれる回に出す
    quoteOn: ['split', 'board'],
    relayInstagram: true,  // Instagram の観測を X に中継し、言葉が付く先を作る
  },

  /* 再掲の約束。
     ・タグを付けた時点で、観測票への再掲に同意したものとして扱う（盤とプロフィールに明記すること）
     ・#再掲不可 を本文に書いた投稿は、盤には載るがフィルム片には焼かない */
  // \b は日本語の後ろで境界にならないので、和文側には付けない
  NO_RELAY_RE: /#再掲不可|#norelay\b/,
};

const NUM_RE = /#観測者(\d{4})\b/;
const today  = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ state -- */
const P = n => path.join(CFG.DIR, n);
const load = async (n, d) => { try { return JSON.parse(await fs.readFile(P(n),'utf8')); } catch { return d; } };
const save = async (n, v) => { await fs.mkdir(CFG.DIR,{recursive:true});
                               await fs.writeFile(P(n), JSON.stringify(v,null,2)+'\n'); };

/* -------------------------------------------------------------- observers -- */
/* 番号は「人」ではなく「呼び名」に与える。SNS を跨いでも handle が同じなら同じ番号。
   名寄せはしない。別人が同じ名を使えば同じ観測者になる——それでよい、という決定。 */
function issueNumber(observers, handle){
  if(!handle) return { num: CFG.ANON, isNew: false };   // 名が取れなければ 0000 号に集まる
  const key = String(handle).toLowerCase().replace(/^@/,'');
  if(observers.byName[key]) return { num: observers.byName[key], isNew: false };

  const claimed = (observers.claim||{})[key];           // 現地カードの番号を名乗っていた場合
  if(claimed && !observers.used.includes(claimed)){
    observers.byName[key] = claimed; observers.used.push(claimed);
    return { num: claimed, isNew: true };
  }
  let n = Math.max(CFG.WEB_FROM, observers.next || CFG.WEB_FROM);
  while(observers.used.includes(String(n).padStart(4,'0'))) n++;
  const num = String(n).padStart(4,'0');
  observers.byName[key] = num; observers.used.push(num); observers.next = n + 1;
  return { num, isNew: true };
}

/* ------------------------------------------------------------------- X --- */
/* タグでもメンションでも拾う。検索は一本にまとめてあるので、増やしても読み取りは増えない。
   has:media で分けないのは、画像なし＝言葉観測として同じ結果から取り出せるため。 */
async function fetchX(state){
  // 検査用。返信・引用の紐づけは実際の会話が無いと確かめられないので、
  // 疑似的な投稿列をファイルから読める口をひとつ開けてある。実運用では使わない。
  if(process.env.X_STUB) return JSON.parse(await fs.readFile(process.env.X_STUB, 'utf8'));
  if(!process.env.X_BEARER) return [];
  const q = encodeURIComponent(`(#${CFG.TAG} OR @${CFG.ACCOUNT}) -is:retweet`);
  const url = `https://api.x.com/2/tweets/search/recent?query=${q}&max_results=100`
    + `&tweet.fields=created_at,referenced_tweets`
    + `&expansions=author_id,attachments.media_keys`
    + `&user.fields=username&media.fields=url,preview_image_url`
    + (state.xSince ? `&since_id=${state.xSince}` : '');
  const r = await fetch(url, { headers:{ Authorization:`Bearer ${process.env.X_BEARER}` }});
  if(!r.ok){ console.error('[X] search failed', r.status, await r.text()); return []; }
  const j = await r.json();
  if(!j.data?.length) return [];
  state.xSince = j.meta?.newest_id || state.xSince;

  const users = Object.fromEntries((j.includes?.users||[]).map(u=>[u.id,u.username]));
  const media = Object.fromEntries((j.includes?.media||[]).map(m=>[m.media_key,m.url||m.preview_image_url]));
  const ref = (t,type) => (t.referenced_tweets||[]).find(r=>r.type===type)?.id || null;
  return j.data.map(t => ({
    src:'x', id:`x:${t.id}`, raw:t.id,
    url:`https://x.com/i/status/${t.id}`,
    handle: users[t.author_id] || null,
    text: t.text || '', at: t.created_at,
    img: (t.attachments?.media_keys||[]).map(k=>media[k]).filter(Boolean)[0] || null,
    // 返信・引用の相手。これが「座標を書かなくても言葉が正しい写真に付く」根拠になる。
    parent: ref(t,'replied_to') ? `x:${ref(t,'replied_to')}`
          : ref(t,'quoted')     ? `x:${ref(t,'quoted')}` : null,
  }));
}

/* -------------------------------------------------------------- Threads --- */
/* Threads の keyword_search は q を一つしか取らないので、タグとメンションで二回引く。
   Threads API は無料（7日で500クエリ／六時間ごとなら週28回）なので、回数は問題にならない。 */
async function fetchThreads(){
  if(!process.env.THREADS_TOKEN) return [];
  const out = new Map();
  for(const q of ['#'+CFG.TAG, '@'+CFG.ACCOUNT]){
    const url = `https://graph.threads.net/v1.0/keyword_search`
      + `?q=${encodeURIComponent(q)}&search_type=RECENT`
      + `&fields=id,text,permalink,username,timestamp,media_url,media_type`
      + `&access_token=${process.env.THREADS_TOKEN}`;
    try{
      const r = await fetch(url);
      if(!r.ok){ console.error('[Threads] search failed', q, r.status, await r.text()); continue; }
      const j = await r.json();
      (j.data||[]).forEach(t => out.set(t.id, {
        src:'threads', id:`th:${t.id}`, raw:t.id, url:t.permalink,
        handle:t.username || null, text:t.text || '', at:t.timestamp,
        img:t.media_url || null,
      }));
    }catch(e){ console.error('[Threads]', q, e.message); }
  }
  return [...out.values()];
}

/* ------------------------------------------------------------ Instagram --- */
/* @メンションは push（webhook）なので、受け口が置いた待ち行列を読むだけ。
   ハッシュタグ検索は投稿者名を返さないので使わない——使うと全部 0000 号になり、
   0000 号が「少ないから効く」という性質が薄まる。 */
async function fetchInstagramQueue(){
  const q = await load('ig-queue.json', []);
  if(!q.length) return [];
  await save('ig-queue.json', []);
  return q.map(m => ({
    src:'instagram', id:`ig:${m.id}`, raw:m.id, url:m.permalink,
    handle:m.username || null,
    text:m.caption || '', at:m.timestamp,
    img:m.media_url || null,   // 署名付きで期限切れする。permalink を必ず残す
  }));
}

/* ------------------------------------------------------------ transform --- */
/* 投稿を読み解く。座標は **あってもなくてもよい**。

   サイトを開かないと座標が分からない、という状態では
   「思い出したときに投げる」習慣は育たない。だから座標を必須にしない。

     座標あり  → その座標に置く
     地点あり  → 盤の外。八つで盤が生まれる
     どちらも無し ＋ 写真 → **未定位の観測**。漂ったまま盤に載る
     どちらも無し ＋ 返信/引用 → 相手の写真への言葉。座標は要らない

   位置は、あとから誰かが付けられる（定位）。撮った本人でなくてもよい。 */
function read(post, observers){
  const cm = COORD_RE.exec(post.text);
  const sm = SEED_RE.exec(post.text);

  const claim = NUM_RE.exec(post.text);
  if(claim && post.handle){
    observers.claim = observers.claim || {};
    const n = claim[1];
    if(!observers.used.includes(n) && parseInt(n,10) <= CFG.LOCAL_TO)
      observers.claim[post.handle.toLowerCase()] = n;
  }

  const { num, isNew } = issueNumber(observers, post.handle);
  const tx = post.text.replace(COORD_RE,'').replace(SEED_RE,'').replace(NUM_RE,'')
    .replace(/@\S+/g,'').replace(/#\S+/g,'').replace(/https?:\/\/\S+/g,'')
    .replace(/[ \u3000]{2,}/g,' ').trim();   // タグを抜いた跡の二重空白を潰す

  return {
    coord: cm ? `${cm[1]}/${cm[2]}` : null,
    seed : sm ? `${sm[1]}${sm[2]}_${sm[3]}${sm[4]}` : null,
    num, isNew, tx,
    obs: { id:post.id, src:post.src, by:num, state:'ok', kind:'photo', yr:'',
           permalink:post.url, at:post.at, tx, img:post.img || null, words:[],
           coord:null, seed:null, handle:post.handle || null, raw_text:post.text },
    word:{ id:post.id, by:num, state:'ok', tx, permalink:post.url, at:post.at },
  };
}

/* ------------------------------------------------------------ decay ------- */
/* 巡回のたびに画像と permalink を叩き、消えていれば褪色・欠落に落とす。
   運営が消すのではなく、放っておいたら褪せる。リンク切れが世界の物理法則になる。 */
async function decay(obs){
  for(const o of obs){
    if(o.state === 'lost') continue;
    try{
      if(o.img){
        const r = await fetch(o.img, { method:'HEAD' });
        if(!r.ok && o.state === 'ok') o.state = 'faded';
      }
      if(o.permalink){
        const r = await fetch(o.permalink, { method:'HEAD', redirect:'follow' });
        if(r.status === 404) o.state = 'lost';
      }
    }catch{ /* 一時的な失敗で消さない。次の現像で判定する */ }
  }
}

/* ------------------------------------------------------------ tally ------- */
const tallyOf = obs => {
  const t = {};
  obs.filter(o=>o.state!=='lost' && o.coord).forEach(o=>{ t[o.coord] = (t[o.coord]||0)+1; });
  return t;
};
const total = (t, code) =>
  Object.keys(t).reduce((n,k)=> (k===code || k.startsWith(code)) ? n + t[k] : n, 0);

/* 銘板 — セルを割った八人。落ちた順の先頭八件で確定し、以後は書き換えない。
   観測が失われても銘板は消えない。 */
function stampPlates(obs, plates, before, after){
  const opened = [];
  for(const code of new Set([...Object.keys(before), ...Object.keys(after)])){
    if(plates[code]) continue;
    if(total(before,code) < CFG.SPLIT_AT && total(after,code) >= CFG.SPLIT_AT){
      plates[code] = obs
        .filter(o => o.coord === code || (o.coord||'').startsWith(code))
        .sort((a,b)=> String(a.at).localeCompare(String(b.at)))
        .slice(0, CFG.SPLIT_AT)
        .map(o => o.by);
      opened.push(code);
    }
  }
  return opened;
}

/* ------------------------------------------------------------ X write ----- */
/* 返信・引用・メディア添付は user context の認証が要る（app-only の bearer では不可）。
   リンクを入れると約13倍になるので、本文に URL は入れない。 */
async function xPost(body, label='post'){
  const url = 'https://api.x.com/2/tweets';
  const auth = writeAuth('POST', url);
  if(CFG.DRY || !auth){ console.log(`[X ${label}]`, JSON.stringify(body)); return null; }
  const r = await fetch(url, {
    method:'POST',
    headers:{ Authorization: auth, 'Content-Type':'application/json' },
    body: JSON.stringify(body),
  });
  if(!r.ok){ console.error(`[X ${label}] failed`, r.status, await r.text()); return null; }
  return (await r.json()).data?.id || null;
}

/* メディアのアップロード。
   POST /2/media/upload に multipart で投げ、返ってきた id を /2/tweets の media_ids に渡す。
   OAuth 1.0a なら media.write のスコープ設定は不要。OAuth 2.0 のときは media.write が要る。
   フィルム片・一葉に焼いて1枚にしてあるので、現像1回につきアップロードは1件だけ。 */
async function xUploadMedia(buf, name='observation.jpg'){
  const url = 'https://api.x.com/2/media/upload';
  const auth = writeAuth('POST', url);
  if(CFG.DRY || !auth){
    console.log('[X media]', name, Math.round(buf.length/1024)+'KB',
                CFG.DRY ? '(DRY_RUN)' : '(認証なし)');
    return null;
  }
  try{
    const fd = new FormData();
    fd.append('media', new Blob([buf], { type:'image/jpeg' }), name);
    fd.append('media_category', 'tweet_image');
    // Content-Type は fetch が boundary 付きで組む。自分で付けないこと。
    const r = await fetch(url, { method:'POST', headers:{ Authorization: auth }, body: fd });
    if(!r.ok){ console.error('[X media] failed', r.status, await r.text()); return null; }
    const d = (await r.json()).data || {};

    // 画像は普通そのまま使えるが、processing_info が付いてきたら終わるまで待つ
    let info = d.processing_info;
    for(let i=0; info && info.state && info.state !== 'succeeded' && i < 5; i++){
      if(info.state === 'failed'){ console.error('[X media] processing failed'); return null; }
      await new Promise(s => setTimeout(s, (info.check_after_secs || 1) * 1000));
      const chk = `${url}?media_id=${encodeURIComponent(d.id)}`;
      const cr = await fetch(chk, { headers:{ Authorization: writeAuth('GET', chk) }});
      if(!cr.ok) break;
      info = ((await cr.json()).data || {}).processing_info;
    }
    console.log('[X media] ok', d.id, Math.round(buf.length/1024)+'KB');
    return d.id || null;
  }catch(e){
    console.error('[X media] failed', e.message);
    return null;
  }
}

/* ------------------------------------------------------------ main -------- */
const state     = await load('state.json', { replies:{} });
const observers = await load('observers.json', { byName:{}, used:[], claim:{}, next:CFG.WEB_FROM });
const obs       = await load('observations.json', []);
const plates    = await load('plates.json', {});
const seeds     = await load('seeds.json', {});          // 地点キー → 観測数
const boards    = await load('boards.json', []);         // 命名済みの盤（bounds は凍結）
const pending   = await load('boards-pending.json', []); // 生まれたが、まだ名の無い盤
const seen      = new Set([...obs.map(o=>o.id), ...obs.flatMap(o=>(o.words||[]).map(w=>w.id))]);

const posts = [
  ...await fetchX(state),
  ...await fetchThreads(),
  ...await fetchInstagramQueue(),
].filter(p => !seen.has(p.id));

const before = tallyOf(obs);
const fresh = [], words = [], located = [];
const byId = new Map(obs.map(o => [o.id, o]));

for(const p of posts){
  const c = read(p, observers);
  // 返信・引用の相手が、こちらの知っている観測かどうか
  const parent = p.parent ? byId.get(p.parent) : null;

  /* --- 1. 写真がある ＝ 観測 ------------------------------------------- */
  if(p.img){
    const o = { ...c.obs, coord:c.coord, seed:c.seed };
    obs.push(o); byId.set(o.id, o);
    fresh.push({ ...o, isNew:c.isNew });
    if(c.seed && !c.coord) seeds[c.seed] = (seeds[c.seed] || 0) + 1;
    continue;
  }

  /* --- 2. 写真が無く、座標があり、相手が未定位 ＝ 定位 -------------------
     撮った本人でなくてよい。「この写真はどこか」を当てるのも、ひとつの観測。 */
  if(c.coord && parent && !parent.coord && !parent.seed){
    parent.coord = c.coord;
    parent.locatedBy = c.num;
    parent.locatedAt = p.at;
    located.push({ o:parent, by:c.num, src:p.src, id:p.id });
    if(c.tx){ parent.words.push(c.word); words.push(c.word); }
    continue;
  }

  /* --- 3. 写真が無い ＝ 言葉観測 ---------------------------------------
     相手が分かるならそこへ。**座標を書かなくても、正しい写真に付く。**
     相手が分からないときだけ、座標／地点でいちばん新しい観測を選ぶ。 */
  if(!c.tx) continue;
  const target = parent
    || (c.coord ? obs.filter(o => o.coord === c.coord && o.state !== 'lost').pop() : null)
    || (c.seed  ? obs.filter(o => o.seed  === c.seed  && o.state !== 'lost').pop() : null);
  if(target){ target.words.push(c.word); words.push(c.word); }
}

/* 未定位の観測。漂ったまま盤に載り、誰かが座標を付けるのを待つ。 */
const drifting = obs.filter(o => o.state !== 'lost' && !o.coord && !o.seed);

await decay(obs);
const after  = tallyOf(obs);
const opened = stampPlates(obs, plates, before, after);

/* ---- 盤が生まれる ---------------------------------------------------------
   八つ目が落ちた地点を中心に、標準寸法で切り出して凍結する。
   ただし **命名は運営** なので、ここでは名を付けない。
   名が付くまで座標も配らない。—— 場所は、名より先に在る。
   運営が boards-pending.json の一件に name を書いて boards.json に移すと、
   次の現像でその盤の観測に座標が付く。                                        */
const born = [];
for(const key of Object.keys(seeds)){
  if(seeds[key] < CFG.SPLIT_AT) continue;
  if(boards.some(b=>b.seed===key) || pending.some(b=>b.seed===key)) continue;
  const bb = seedKeyBounds(key);
  if(!bb) continue;
  const bounds = deriveBoard(centerOf(bb), [...boards, ...pending].map(b=>b.bounds));
  pending.push({ seed:key, bounds, at:new Date().toISOString(), n:seeds[key] });
  born.push(key);
}

/* ---- 書き込み ------------------------------------------------------------ */
/* 1) 返信は「初回の発番」だけ。観測者が増えても返信は増え続けない。
      一日の上限を超えたら止め、束ね投稿に任せる。 */
const day = today();
const at  = new Date().toISOString().slice(0,16).replace('T',' ');
state.replies[day] = state.replies[day] || 0;
if(CFG.POST.reply !== 'none'){
  for(const o of fresh){
    if(o.src !== 'x') continue;
    if(CFG.POST.reply === 'first' && !o.isNew) continue;
    if(state.replies[day] >= CFG.POST.replyDailyCap) break;
    await xPost({ text:`観測者${o.by}号。記録しました。\nここからはもう返しません。盤で確かめてください。`,
                  reply:{ in_reply_to_tweet_id:o.id.slice(2) } }, 'reply');
    state.replies[day]++;
  }
}

/* 2) 現像ごとに1本だけ出す。投稿数は日4本が上限で、観測が何件来ても増えない。
      4コマをフィルム片1枚に焼くので、縦横がばらばらでも見た目が毎回同じになり、
      アップロードするメディアも1件で済む。
      Instagram から来た観測をここに混ぜることで、X 上に言葉が付く先ができる。 */
if(CFG.POST.develop && fresh.length){
  const relay = (CFG.POST.relayInstagram ? fresh : fresh.filter(o=>o.src!=='instagram'))
    .filter(o => !CFG.NO_RELAY_RE.test(o.raw_text || ''))   // #再掲不可 は焼かない
    .filter(o => o.img);
  const pick  = relay.slice(0, 4);

  let media = [];
  if(CFG.POST.strip && pick.length){
    try{
      const buf = await buildStrip(
        pick.map(o=>({ img:o.img, coord:o.coord || o.seed || 'UNLOCATED',
                       by:o.by, handle:o.handle })),
        at, CFG.ACCOUNT);
      const id = await xUploadMedia(buf, 'strip.jpg');
      if(id) media = [id];
      await fs.mkdir(P('strips'),{recursive:true});
      await fs.writeFile(P(`strips/${at.replace(/[: ]/g,'-')}.jpg`), buf);  // 焼いた分は残す
    }catch(e){ console.error('[strip] 失敗', e.message); }
  }

  const lines = pick.map(o=>`${o.coord || o.seed || '位置未定'} ／ ${o.by}号`).join('\n');
  const more  = fresh.length > pick.length ? `\nほか ${fresh.length - pick.length} 件。` : '';
  const unloc = pick.filter(o=>!o.coord && !o.seed).length;
  // 未定位があるときは「どこか分かる人がいたら教えてほしい」を必ず添える。
  // これがいちばん摩擦の低い参加口で、しかも会話が生まれる。
  const call  = unloc
    ? `\n位置の分からない写真が ${unloc} 枚あります。心当たりがあれば、返信で座標を書いてください。`
    : `\n言葉を足すときは、この投稿かコマに返信してください。座標は要りません。`;
  // 位置が決まった写真があれば、その報せを同じ一本に載せる。
  // 別の投稿にしないのは費用のため。事件は本文の中でも十分伝わる。
  const found = located.length
    ? '\n\n' + located.slice(0,3).map(l=>`${l.o.coord} の位置が決まりました。${l.by}号が見つけました。`).join('\n')
    : '';
  await xPost({
    text: `現像しました。\n${lines}${more}${call}${found}`,
    ...(media.length ? { media:{ media_ids: media } } : {}),
  }, 'develop');
}

/* 2b) 二次現像 ── 言葉が焼き込まれた一葉。
      六時間ごとの現像は写真だけ（写真が先に来る）。
      言葉が付いた観測は、一日一回この形で出す。これが「説明が拡散していく」経路。
      引用でも返信でもなく、言葉そのものが画像になって外へ出るので、
      読んだ人は元の投稿を開かなくても、何を見てどう語られたかが分かる。 */
if(CFG.POST.develop && new Date().getUTCHours() === CFG.POST.leafHour){
  const worded = obs
    .filter(o => o.state !== 'lost' && o.img && (o.words||[]).some(w=>w.state!=='lost' && w.tx))
    .filter(o => !CFG.NO_RELAY_RE.test(o.raw_text || ''))
    .filter(o => !state.leafed?.includes(o.id))
    .sort((a,b)=> (b.words?.length||0) - (a.words?.length||0));
  const o = worded[0];
  if(o){
    try{
      const buf = await buildLeaf({
        img:o.img, coord:o.coord || o.seed || 'UNLOCATED', by:o.by, handle:o.handle, at,
        tx:o.tx, words:(o.words||[]).filter(w=>w.state!=='lost' && w.tx),
      }, CFG.ACCOUNT);
      const id = await xUploadMedia(buf, 'leaf.jpg');
      await fs.mkdir(P('leaves'),{recursive:true});
      await fs.writeFile(P(`leaves/${o.id.replace(/[:\/]/g,'-')}.jpg`), buf);
      await xPost({
        text: `${o.coord || o.seed || '位置未定の観測'} に言葉が付きました。\n観測 ${o.by}号 ／ 言葉 ${(o.words||[]).map(w=>w.by+'号').join('・')}`,
        ...(id ? { media:{ media_ids:[id] } } : {}),
      }, 'leaf');
      state.leafed = [...(state.leafed||[]), o.id];
    }catch(e){ console.error('[leaf] 失敗', e.message); }
  }
}

/* 3) 引用リポストは事件のときだけ。八つ目を落とした人を称える。 */
if(CFG.POST.quoteOn.includes('split')){
  for(const code of opened){
    const o = fresh.find(f => f.coord === code || (f.coord||'').startsWith(code));
    if(o?.src === 'x'){
      const named = (plates[code]||[]).filter(x=>x!==CFG.ANON).length;
      await xPost({ text:`${code} が割れました。\n八つの観測が、この区画をさらに 4×4 にしています。\n`
                        + (named === 0 ? '八人とも名を残していません。' : `銘板：${plates[code].join(' ')}`),
                    quote_tweet_id:o.id.slice(2) }, 'quote');
    }
  }
}

/* 3b) 盤が生まれたとき。月に何度もない事件なので、必ず出す。 */
if(CFG.POST.quoteOn.includes('board')){
  for(const key of born){
    const o = fresh.find(f => f.seed === key);
    await xPost({
      text:`盤が生まれました。\n${key} を中心に、約 4.3 × 4.5 km。\nこの盤にはまだ名がありません。`,
      ...(o?.src === 'x' ? { quote_tweet_id:o.id.slice(2) } : {}),
    }, 'board');
  }
}

await save('observations.json', obs);
await save('observers.json', observers);
await save('plates.json', plates);
await save('seeds.json', seeds);
await save('boards-pending.json', pending);
await save('state.json', state);

/* 盤に読ませる一枚。CONFIG.INGEST.FEED をこれに向ける。
   boards は命名済みのものだけ。名の無い盤は座標を配れないので出さない。 */
await save('feed.json', {
  at: new Date().toISOString(),
  tally: after,
  seeds,
  plates,
  boards: boards.filter(b=>b.name && b.bounds),
  // 未定位の観測。盤の「世界」タブに並び、誰かが座標を付けるのを待つ。
  drifting: drifting.map(o=>({
    id:o.id, by:o.by, state:o.state, img:o.img, permalink:o.permalink, at:o.at, tx:o.tx,
    words:(o.words||[]).map(w=>({ by:w.by, state:w.state, tx:w.tx })),
  })),
  records: obs.filter(o=>o.coord).map(o=>({
    coord:o.coord, yr:o.yr||'', by:o.by, kind:o.kind||'photo', state:o.state,
    img:o.img, permalink:o.permalink, tx:o.tx, locatedBy:o.locatedBy || null,
    words:(o.words||[]).map(w=>({ by:w.by, state:w.state, tx:w.tx })),
  })),
});

console.log(`[観測] 新規 ${fresh.length} ／ 言葉 ${words.length} ／ 総数 ${obs.length}`
          + ` ／ 定位 ${located.length} ／ 未定位 ${drifting.length}`
          + ` ／ 割れたセル ${opened.length} ／ 生まれた盤 ${born.length}`
          + ` ／ 無記名 ${obs.filter(o=>o.by===CFG.ANON).length}`
          + ` ／ 本日の返信 ${state.replies[day]}`
          + ` ／ 認証 ${hasOAuth1() ? 'OAuth1.0a' : (canWrite() ? 'OAuth2' : 'なし')}`);

if(pending.length){
  console.log(`[要対応] 名の無い盤が ${pending.length} 件あります。`
            + ` boards-pending.json に name を書いて boards.json へ移してください。`
            + ` 名が付くまで、その盤の観測に座標は配られません。`);
}
