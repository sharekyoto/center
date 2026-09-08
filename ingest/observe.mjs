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
import { COORD_RE, SEED_RE, seedKeyBounds, centerOf, deriveBoard, normalizeTags } from './board.mjs';
import { locateText } from './places.mjs';   /* 町名タグ → 座標タグ */

/* 秘密は環境変数から。公開ファイルに書かない。 */
function envJson(name, d){
  const v = process.env[name];
  if(!v) return d;
  try { return JSON.parse(v); }
  catch(e){ console.error(`[${name}] JSON として読めません。`, e.message); return d; }
}
function envKeys(name){
  const v = process.env[name];
  if(!v) return [];
  const t = v.trim();
  if(t.startsWith('[')) return envJson(name, []);
  return t.split(/\/\/\/|\r?\n/).map(x=>x.trim()).filter(Boolean);
}

const CFG = {
  TAG: '観測センター',
STRICT: true,
  ACCOUNT: 'alembicity',   // X・Instagram・Threads 共通。タグでもメンションでも拾う
  SPLIT_AT: 8,
  ANON: '0000',
  WEB_FROM: 101,
  LOCAL_FROM: 8,          // 現地カードの下限。0001-0007 は作中人物なので名乗らせない
  LOCAL_TO: 100,

  /* 観測員証の鍵。公開リポジトリには置かない。
     OBSERVER_KEYS  53語の語彙。JSON配列 or 「///」区切りの一行
     OBSERVER_CARDS 0008-0100 の割り当て。{"0008":"むくち。しゅやく。たんにん", ...}
     どちらも未設定なら、カード番号の申告は一切通らない（誤って開くより閉じる）。 */
  KEYS:  envKeys('OBSERVER_KEYS'),
  CARDS: envJson('OBSERVER_CARDS', {}),
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

const NUM_RE = /#(?:観測員|観測者|発見者)(\d{4})\b/;   // 正は観測員。旧表記も受ける

/* ------------------------------------------------------------------ 鍵 --- */
/* 照合は CFG.KEYS との完全一致だけ。本文から三語を推測することは絶対にしない
   （「今日は暑い。壁が濡れた。窓が開いた」が鍵に見えてしまい、観測本文を消す）。 */
const W3W_URL_RE = /https?:\/\/(?:www\.)?what3words\.com\/\S+/gi;
const splitKey = k => String(k||'').split(/[。．.／\/]/).map(x=>x.trim()).filter(Boolean);

function keyPattern(key){
  const w = splitKey(key);
  if(w.length !== 3) return null;
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?:///)?\\s*' + w.map(esc).join('\\s*[。．.／/]\\s*'));
}
function unpercent(t){
  if(!/%[0-9A-Fa-f]{2}/.test(t)) return t;
  try { return decodeURIComponent(t); } catch { return t; }
}
/* 生の本文とパーセントデコード後の両方を見る。X は URL を %E3%82%80… で出す。 */
function findKey(text, pool){
  const t = String(text || '');
  const probe = t + '\n' + unpercent(t);
  for(const k of (pool || [])){
    const re = keyPattern(k);
    if(re && re.test(probe)) return { key:k, raw:(re.exec(t)||[null])[0] };
  }
  return null;
}
const sameKey = (a,b) => splitKey(a).join('。') !== '' && splitKey(a).join('。') === splitKey(b).join('。');
const stripKey = (text, found) => {
  let b = String(text||'').replace(W3W_URL_RE, '');
  if(found && found.raw) b = b.split(found.raw).join('');
  return b;
};
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
  const cur = observers.byName[key];

  const claimed = (observers.claim||{})[key];           // 現地カードの番号を名乗っていた場合

  /* 乗り換え。回線から先に番号をもらった人が、あとからカードを名乗った場合。
     現地でカードを受け取る前に一枚投げてしまうのはごく普通に起きるので、
     ここを塞ぐとカードが死ぬ。旧番号は欠番として used に残し、二度と配らない。 */
  if(cur && claimed && claimed !== cur){
    observers.byName[key] = claimed;
    if(!observers.used.includes(claimed)) observers.used.push(claimed);
    observers.retired = observers.retired || {};
    observers.retired[cur] = claimed;                  // 欠番 → 引き継ぎ先
    delete observers.claim[key];
    return { num: claimed, isNew: true, from: cur };
  }
  if(cur) return { num: cur, isNew: false };

  if(claimed && !observers.used.includes(claimed)){
    observers.byName[key] = claimed; observers.used.push(claimed);
    delete observers.claim[key];
    return { num: claimed, isNew: true };
  }
  let n = Math.max(CFG.WEB_FROM, observers.next || CFG.WEB_FROM);
  while(observers.used.includes(String(n).padStart(4,'0'))) n++;
  const num = String(n).padStart(4,'0');
  observers.byName[key] = num; observers.used.push(num); observers.next = n + 1;
  return { num, isNew: true, key: issueKey(observers, num) };
}

/* カードに刷ってある鍵。Secret にしか無い。 */
const cardKey = num => (CFG.CARDS || {})[num] || null;

/* 0101 以降に配る鍵。公開ファイルには語彙の番号だけを残す。
   語彙そのものは Secret にあるので、17 という数字だけ見ても何も判らない。 */
function issueKey(observers, num){
  const pool = CFG.KEYS || [];
  if(!pool.length) return null;
  observers.keyIx = observers.keyIx || {};
  if(observers.keyIx[num] != null) return pool[observers.keyIx[num]] || null;
  const i = Math.floor(Math.random() * pool.length);
  observers.keyIx[num] = i;
  return pool[i];
}
const keyOf = (observers, num) =>
  cardKey(num) || (CFG.KEYS || [])[(observers.keyIx || {})[num]] || null;

/* 乗り換えたら、それまでの記録も新しい番号に付け替える。
   旧番号は記録ゼロの欠番になる。既に X に流れたフィルム片の焼き込みは直せない。 */
function migrateNumber(obs, from, to){
  let n = 0;
  for(const o of obs){
    if(o.by === from){ o.by = to; n++; }
    for(const w of (o.words || [])) if(w.by === from){ w.by = to; n++; }
  }
  if(n) console.log(`[番号] ${from} → ${to} に付け替えました（${n}件）。${from} は欠番。`);
}

/* ------------------------------------------------------------------- X --- */
/* タグでもメンションでも拾う。検索は一本にまとめてあるので、増やしても読み取りは増えない。
   has:media で分けないのは、画像なし＝言葉観測として同じ結果から取り出せるため。 */
/* since_id は7日を過ぎると検索窓の外に出て、X が黙って 400 を返す。
   古くなったら捨てて start_time に切り替える。重複は seen が弾くので二重処理は起きない。
   これが無いと「誰も投稿しなかった」と見分けが付かないまま何週間も止まる。 */
const X_EPOCH = 1288834974657n;
function freshSince(id){
  if(!id) return null;
  try{
    const ms = Number((BigInt(id) >> 22n) + X_EPOCH);
    if(Date.now() - ms < 6.5*24*3600*1000) return String(id);
    console.log('[X] since_id が7日の窓を過ぎたので捨てます。');
  }catch{ console.log('[X] since_id が読めないので捨てます。'); }
  return null;
}

async function fetchX(state){
  // 検査用。返信・引用の紐づけは実際の会話が無いと確かめられないので、
  // 疑似的な投稿列をファイルから読める口をひとつ開けてある。実運用では使わない。
  if(process.env.X_STUB) return JSON.parse(await fs.readFile(process.env.X_STUB, 'utf8'));
  if(!process.env.X_BEARER) return [];
  const q = encodeURIComponent(`(#${CFG.TAG} OR @${CFG.ACCOUNT}) -is:retweet`);
  const since = freshSince(state.xSince);
  const url = `https://api.x.com/2/tweets/search/recent?query=${q}&max_results=100`
    + `&tweet.fields=created_at,referenced_tweets`
    + `&expansions=author_id,attachments.media_keys`
    + `&user.fields=username&media.fields=url,preview_image_url`
    + (since ? `&since_id=${since}`
             : `&start_time=${new Date(Date.now() - 6.5*24*3600*1000).toISOString()}`);
  const r = await fetch(url, { headers:{ Authorization:`Bearer ${process.env.X_BEARER}` }});
  if(!r.ok){
    const body = await r.text();
    console.error('[X] search failed', r.status, body);
    /* ここで黙って [] を返すと「誰も投稿しなかった」と見分けが付かない。
       クレジットが切れた日から何日も気づけないのがいちばん困るので、落として気づけるようにする。
         402 クレジット切れ ／ 401 鍵が違う ／ 403 権限不足 ── どれも人が動かないと直らない
         429 レート制限 ／ 5xx X 側の不調   ── 次の巡回で取り返せるので落とさない */
    if(r.status === 400 || r.status === 401 || r.status === 402 || r.status === 403){
      console.error('[要対応] X が読めていません。'
        + (r.status === 402 ? 'クレジット残高を確認してください。'
        :  r.status === 401 ? '鍵（X_BEARER）を確認してください。'
        :  r.status === 400 ? '検索の条件が受け付けられていません。since_id か query を確認してください。'
        :                     'アプリの権限（Read）を確認してください。'));
      process.exitCode = 1;
    }
    return [];
  }
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
  /* タグ検索は search_mode=TAG で、q に # を付けない。
     # を付けたままキーワード検索すると、タグ付き投稿は拾えず空が返る。
     メンションのほうは素のキーワード検索でよい。 */
  const queries = [
    { q: CFG.TAG,          mode: 'TAG'     },
    { q: '@'+CFG.ACCOUNT,  mode: 'KEYWORD' },
  ];
  for(const { q, mode } of queries){
    const url = `https://graph.threads.net/v1.0/keyword_search`
      + `?q=${encodeURIComponent(q)}&search_type=RECENT&search_mode=${mode}`
      + `&fields=id,text,permalink,username,timestamp,media_url,media_type`
      + `&access_token=${process.env.THREADS_TOKEN}`;
    try{
      const r = await fetch(url);
      if(!r.ok){ console.error('[Threads] 検索できません', mode, q, r.status, await r.text()); continue; }
      const j = await r.json();
      (j.data||[]).forEach(t => out.set(t.id, {
        src:'threads', id:`th:${t.id}`, raw:t.id, url:t.permalink,
        handle:t.username || null, text:t.text || '', at:t.timestamp,
        img:t.media_url || null,
      }));
    }catch(e){ console.error('[Threads]', mode, q, e.message); }
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
  const text = normalizeTags(post.text);   // 触るのはタグだけ。本文は変えない
  const cm = COORD_RE.exec(text);
  const sm = SEED_RE.exec(text);

  /* 現地カードの名乗り。番号だけでは通さない。
       ・0008-0100 の範囲であること（0001-0007 は作中人物。名乗らせない）
       ・カードに刷られた鍵と一致すること
       ・まだ誰も使っていないこと
     鍵を探すのは名乗りのある投稿だけ。ふつうの観測本文には触れない。 */
  const claim = NUM_RE.exec(text);
  const said  = claim ? findKey(text, CFG.KEYS) : null;
  if(claim && post.handle){
    const n = claim[1], v = parseInt(n,10);
    const want = cardKey(n);
    const ok = v >= CFG.LOCAL_FROM && v <= CFG.LOCAL_TO
            && want && said && sameKey(said.key, want)
            && !observers.used.includes(n);
    if(ok){
      observers.claim = observers.claim || {};
      observers.claim[post.handle.toLowerCase()] = n;
    } else if(said || v <= CFG.LOCAL_TO){
      console.log(`[名乗り] ${n} は通しませんでした（範囲・鍵・使用済みのいずれか）。`);
    }
  }

  const { num, isNew, from, key } = issueNumber(observers, post.handle);

  /* 鍵は本文から必ず落とす。盤にもフィルム片にも残さない。 */
  const body = stripKey(text, said);

  const tx = body.replace(COORD_RE,'').replace(SEED_RE,'').replace(NUM_RE,'')
    .replace(/@\S+/g,'').replace(/#\S+/g,'').replace(/https?:\/\/\S+/g,'')
    .replace(/[ \u3000]{2,}/g,' ').trim();   // タグを抜いた跡の二重空白を潰す

  return {
    coord: cm ? `${cm[1]}/${cm[2]}` : null,
    seed : sm ? `${sm[1]}${sm[2]}_${sm[3]}${sm[4]}` : null,
    num, isNew, from, key, tx,
    obs: { id:post.id, src:post.src, by:num, state:'ok', kind:'photo', yr:'',
           permalink:post.url, at:post.at, tx, img:post.img || null, words:[],
           coord:null, seed:null, handle:post.handle || null, raw_text:body },
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
const places    = await load('places.json', {});         // 町名 → 緯度経度（育つ辞書）
const boards    = await load('boards.json', []);         // 命名済みの盤（bounds は凍結）
const pending   = await load('boards-pending.json', []); // 生まれたが、まだ名の無い盤
const seen      = new Set([...obs.map(o=>o.id), ...obs.flatMap(o=>(o.words||[]).map(w=>w.id))]);

const posts = [
  ...await fetchX(state),
  ...await fetchThreads(),
  ...await fetchInstagramQueue(),
].filter(p => !seen.has(p.id));

/* ---- 町名を座標に翻訳する --------------------------------------------------
   #下京区朱雀宝蔵町 のような、人が手で打てるタグを受けるための一手間。
   本文は変えない。末尾に座標タグを一つ足すだけで、あとは既存の読み取りに任せる。
   一度引いた町名は places.json に残り、二度目からは回線を使わない。 */
const geoBudget = { left: 40 };   /* 一回の現像で住所検索に尋ねる上限 */
for(const p of posts){
  const found = await locateText(p.text || '', places, geoBudget);
  if(!found) continue;
  p.text = `${p.text} ${found.tag}`;
  console.log(`[places] ${found.name} → ${found.tag}${found.cached ? '' : '（照会）'}`);
}

const before = tallyOf(obs);
const fresh = [], words = [], located = [];
const byId = new Map(obs.map(o => [o.id, o]));

for(const p of posts){
  const c = read(p, observers);
  if(c.from) migrateNumber(obs, c.from, c.num);   // 乗り換え。旧番号の記録を引き継ぐ
  // 返信・引用の相手が、こちらの知っている観測かどうか
  const parent = p.parent ? byId.get(p.parent) : null;

  /* --- 1. 写真がある ＝ 観測 ------------------------------------------- */
  if(p.img){
    const o = { ...c.obs, coord:c.coord, seed:c.seed };
    obs.push(o); byId.set(o.id, o);
    fresh.push({ ...o, isNew:c.isNew, key:c.key || null });
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
    const k = o.key || keyOf(observers, o.by);
    await xPost({ text:`観測員${o.by}号。記録しました。`
                  + (k ? `\n鍵は ${k} です。控えておいてください。` : '')
                  + `\nここからはもう返しません。盤で確かめてください。`,
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
await save('places.json', places);
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
