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
import { buildStrip, buildLeaf, buildPair } from './contact.mjs';
import { writeAuth, canWrite, hasOAuth1 } from './x-auth.mjs';
import { COORD_RE, SEED_RE, seedKeyBounds, centerOf, deriveBoard, normalizeTags, cellAt, seedOf } from './board.mjs';
import { locateText } from './places.mjs';   /* 町名タグ → 座標タグ */
import { readProfile, applyProfile, noteAck, noteMiss, isFrozen } from './profile.mjs';
import { recordSource, recordTags, postscriptBlock } from './recordpage.mjs';

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
    threadsReply: false,   // Threadsへの初回返信。threads_manage_replies等の権限審査が通るまで false のまま。
                            // 審査が通ったら true にするだけで、コードの他の変更は不要。
    develop: true,         // 現像ごとに1本だけ出す。投稿数の上限は日4本
    strip: true,           // 4コマをフィルム片1枚に焼いて添付する
    leafHour: 9,           // UTC 9時＝JST 18時。一葉はいちばん読まれる回に出す
    quoteOn: ['split', 'board'],
    pair: true,            // 写真つきの追伸が届いたら、記述と現況を一枚に並べて出す（一回に一本）
    openCell: true,        // 盤の区画に初めて観測が置かれたら「開区」を告げる
    almanac: true,         // data/almanac.json に今日の日付があれば「○年前の今日」を一日一本
    relayInstagram: true,  // Instagram の観測を X に中継し、言葉が付く先を作る
  },

  /* 再掲の約束。
     ・タグを付けた時点で、観測票への再掲に同意したものとして扱う（盤とプロフィールに明記すること）
     ・#再掲不可 を本文に書いた投稿は、盤には載るがフィルム片には焼かない */
  // \b は日本語の後ろで境界にならないので、和文側には付けない
  NO_RELAY_RE: /#再掲不可|#norelay\b/,
};

const NUM_RE = /#(?:観測員|観測者|発見者)(\d{4})\b/;
const MENTION_RE = new RegExp('[@＠]' + CFG.ACCOUNT + '(?![A-Za-z0-9_])', 'i');   // 正は観測員。旧表記も受ける

/* ------------------------------------------------------------ 現象 ------- */
/* #反復 でも #LOOP でも、#現象反復 #現象LOOP でも受ける。
   入口は広く、出口は一つ。拡散のために素の日本語表記を許す。
   \b は日本語の後ろで境界にならないので、正規表現一本では書かない。
   タグを切り出してから表を引く。 */
const PH = {
  STAY:'STAY', 停滞:'STAY',   STRA:'STRA', 層露:'STRA',
  FORK:'FORK', 分岐:'FORK',   LOOP:'LOOP', 反復:'LOOP',
  FLEX:'FLEX', 伸縮:'FLEX',   REVE:'REVE', 逆行:'REVE',
  DEJA:'DEJA', 既視:'DEJA',   CHAO:'CHAO', 混沌:'CHAO',
  OOPA:'OOPA', OOPARTS:'OOPA'
};
const TAGS_RE = /[#＃]([^\s#＃]{1,24})/g;

/* 投稿者の見立て。あくまで提案で、確定ではない。
   現象番号を決めるのは処置の仕事。ここでは code を書かない。 */
function phenomenonOf(text){
  for(const m of String(text || '').matchAll(TAGS_RE)){
    const k = m[1].normalize('NFKC').replace(/^現象/, '').toUpperCase();
    if(PH[k]) return PH[k];
  }
  /* 三行の三つ目。タグにしなくても、一語だけの行なら見立てとして受ける。
     「逆行」「現象：逆行」「現象 逆行。」のどれでもよい。文の途中の語は拾わない。 */
  for(const line of String(text || '').split(/\n/)){
    const k = line.normalize('NFKC').trim()
      .replace(/^現象[\s:：]*/, '').replace(/[。.]$/, '').toUpperCase();
    if(PH[k]) return PH[k];
  }
  return null;
}

/* ------------------------------------------------------------ 三行 ------- */
/* 記述の型。
     かつて、ここは＿＿だった。   → then（地層）
     今、ここは＿＿である。       → now（いま）
     逆行                         → hint（現象。phenomenonOf が読む）
   どれも任意。欠けた行は「待ち」として残り、誰かの追伸で埋まる。
   行は書かれたまま残す（言い換えない）。空欄のまま送られた様式（＿＿）は拾わない。 */
const PLACE_LINE_RE = /(^|\n)[ \u3000]*場所[ \u3000]*[：:]?[ \u3000]*([^\s#＃@＠]{1,30})[ \u3000]*(?=\n|$)/;
function placeLine(text){
  const m = PLACE_LINE_RE.exec(String(text || ''));
  if(!m) return null;
  const value = m[2].normalize('NFKC');
  const c = /^(?:KYOTO[_\-\/]?)?([A-Ha-h][1-8](?:[a-hA-H][1-8])*)$/i.exec(value);
  const tag = c ? '#KYOTO_' + c[1][0].toUpperCase() + c[1].slice(1).toLowerCase().replace(/^(\d)/, '$1') : '#' + value.replace(/^#/, '');
  const rest = text.slice(0, m.index) + m[1] + text.slice(m.index + m[0].length);
  return { tag, value, rest };
}
const PH_LINE_RE = /^[ \u3000]*現象[ \u3000]*[：:]?/;
const THEN_RE = /^[ \u3000]*(?:かつて|昔|むかし)[、，,\s\u3000は]/;
const NOW_RE  = /^[ \u3000]*(?:今|いま)[、，,\s\u3000は]/;
const BLANK_RE = /[＿_]{2,}|＿/;
function threeLines(text){
  const r = {};
  for(const line of String(text || '').split(/\n/)){
    const t = line.replace(/[@＠]\S+/g, '').replace(/[#＃]\S+/g, '').trim();
    if(!t || BLANK_RE.test(t)) continue;
    if(THEN_RE.test(t)){ if(!r.then) r.then = Array.from(t).slice(0, 80).join(''); }
    else if(NOW_RE.test(t)){ if(!r.now) r.now = Array.from(t).slice(0, 80).join(''); }
    else if(PH_LINE_RE.test(t) || PH[t.normalize('NFKC').replace(/[。.]$/, '').toUpperCase()]){ /* 現象の行 */ }
    else if(!r.first) r.first = Array.from(t).slice(0, 200).join('');   /* 観測の一行（記録票の 01 観測 欄） */
  }
  return r;
}

/* ------------------------------------------------------------ 記録番号 --- */
/* 受理した順に振り、二度と変えない。場所があとで確定しても振り直さない。
   振り直すと、すでに出回った #追伸XXX0001 の宛先が消える。

   接頭辞は受理したときの座標で決まり、以後は動かさない。
   盤の中の区画は動かないので UMK と KYO は永久に正しい。
   動きうるのは「盤の外に、あとから盤が生まれたとき」だけなので、
   そこを XXX で固定する。XXX は X 三つ、そのままの意味。
   まだ名前の付いていない土地の印であり、埋まらないままの器。 */
const AREA_MAP = { E6:'UMK' };   /* 梅小路。センターの足元 */
const AREA_IN  = 'KYO';          /* 京都盤の中、UMK 以外 */
const AREA_OUT = 'XXX';          /* 盤の外 */

function areaOf(coord){
  if(!coord || !String(coord).includes('/')) return AREA_OUT;
  const top = String(coord).split('/')[1].slice(0, 2).toUpperCase();
  return AREA_MAP[top] || AREA_IN;
}

/* 番号の帯。観測員番号と同じ約束にする。
     0001–4999  外部回線から受理して、機械が発番する
     5001–      窓から人が起こす（写真より先に、言葉から始まった記録）
   帯が分かれていれば、機械と人が同じ瞬間に番号を取ってもぶつからない。 */
const MACHINE_MAX = 4999;

/* ------------------------------------------------------------ 追伸 ------- */
/* すでに受理された記録に、あとから言葉を足す。新しい記録票を発行しない。
   そして処置を待たずに読める。処置がやるのは本文へ繰り上げること（収載）だけで、
   繰り上げられなくても追伸は読める。見えることと、収載されることを分ける。
   処置が滞っても、参加した人の言葉が死なない。ここが要点。

   正しい形は #追伸XXX0001。ハイフンを入れない。
   #追伸XXX-0001 と書くと、押せるタグは #追伸XXX までで、-0001 はただの文字になる。
   全記録の追伸が一つの一覧に混ざってしまう。
   ただし読むほうは寛容にする。書き方のせいで拾えないのは、こちらの都合だから。 */
const PS_RE     = /[#＃]追伸/;
const PS_NUM_RE = /[#＃]追伸[\s\u3000]*([A-Za-z]{3})?[-_\s\u3000]*0*(\d{1,4})(?!\d)/;

/* 記録番号だけが書かれた投稿（「UMK0012 今、ここは駐車場である。」）も追伸として受ける。
   #追伸 を覚えていなくても、番号を添えれば届く。受理済みの番号に完全一致したときだけ。 */
const AID_RE = /(?<![A-Za-z0-9])(UMK|KYO|XXX)[-_]?(\d{4})(?!\d)/i;
function aidInText(text, obs){
  const m = AID_RE.exec(String(text || '').normalize('NFKC'));
  if(!m) return null;
  const aid = m[1].toUpperCase() + m[2];
  return obs.find(o => o.aid === aid) || null;
}

/* wiki にだけある記録（小説由来の UMK0001〜0011、収蔵品 KYO0001〜0025）への追伸。
   観測（observations.json）には居ないので、番号が明示されたときだけ拾い、
   fateofether が記録票の末尾に書き足す。 */
function wikiOnlyAid(text, obs){
  const t = String(text || '').normalize('NFKC');
  const m = PS_NUM_RE.exec(t) || AID_RE.exec(t);
  if(!m) return null;
  const area = (m[1] || '').toUpperCase();
  const n = Number(m[2]);
  if(!AID_FLOOR[area] || n < 1 || n > AID_FLOOR[area]) return null;
  const aid = area + String(n).padStart(4, '0');
  return obs.some(o => o.aid === aid) ? null : aid;
}

function postscriptTarget(text, parent, obs){
  const m = PS_NUM_RE.exec(String(text || ''));
  if(m){
    const num  = String(Number(m[2])).padStart(4, '0');
    const area = (m[1] || '').toUpperCase();
    if(area){
      const hit = obs.find(o => o.aid === area + num);
      if(hit) return hit;
    } else {
      /* 接頭辞なし。ちょうど一件のときだけ採る。
         取り違えて他人の記録に付けるより、保留にして人が直すほうが安い。 */
      const hit = obs.filter(o => o.aid && o.aid.slice(-4) === num);
      if(hit.length === 1) return hit[0];
    }
  }
  /* 番号で決まらなければ、返信・引用の相手から解く */
  return parent || null;
}
/* 物語と収蔵品が先に押さえている番号。機械はこの次からしか振らない。
     UMK0001〜0011  小説からの引用（連載記録 UMEKOJI）
     KYO0001〜0025  収蔵品
   archive.json を手で戻しても、一度きりの振り直しが走っても、ここより下は出さない。 */
const AID_FLOOR = { UMK: 11, KYO: 25 };

function issueAid(archive, coord){
  const area = areaOf(coord);
  const n = Math.max(archive[area] || 0, AID_FLOOR[area] || 0) + 1;
  if(n > MACHINE_MAX) throw new Error('[番号] ' + area + ' の機械枠が尽きました');
  archive[area] = n;
  return area + String(n).padStart(4, '0');
}

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

/* 平安京の呼び名。KYOTO/E6f3 → 'KYOTO E6（右京六条一坊）'。map.html の heian() と同じ割り */
const KAN = ['','一','二','三','四','五','六','七','八'];
function cellName(coord){
  const m = /^KYOTO\/([A-H])([1-8])/.exec(String(coord || ''));
  if(!m) return '';
  const i = 'ABCDEFGH'.indexOf(m[1]);
  return `KYOTO ${m[1]}${m[2]}（${i < 4 ? '左京' : '右京'}${KAN[+m[2]]}条${KAN[i < 4 ? 4 - i : i - 3]}坊）`;
}
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

/* 一回の巡回で読む上限。100件×ページ数。超えたら since_id を進めず、次の巡回で読み直す。
   読み直しは seen で弾かれるので二重にはならない（読み取りの課金だけが増える）。 */
const X_MAX_PAGES = 10;

async function fetchX(state){
  // 検査用。返信・引用の紐づけは実際の会話が無いと確かめられないので、
  // 疑似的な投稿列をファイルから読める口をひとつ開けてある。実運用では使わない。
  if(process.env.X_STUB) return JSON.parse(await fs.readFile(process.env.X_STUB, 'utf8'));
  if(!process.env.X_BEARER) return [];
  const q = encodeURIComponent(`(#${CFG.TAG} OR @${CFG.ACCOUNT}) -is:retweet`);
  const since = freshSince(state.xSince);
  if(state.xSince && !since) delete state.xSince;     /* 捨てた印は残さない。毎回同じ報せを出さないため */
  /* 印が無いときは、前回読み終えた時刻から読む（1時間の重ね代つき）。
     新しい投稿が来ない週に、同じ6.5日分を毎回読み直して課金されるのを防ぐ。 */
  const startedAt = new Date();
  const floorMs = Date.now() - 6.5*24*3600*1000;
  const fromMs  = Math.max(floorMs, state.xAt ? Date.parse(state.xAt) - 3600*1000 : floorMs);
  const base = `https://api.x.com/2/tweets/search/recent?query=${q}&max_results=100`
    + `&tweet.fields=created_at,referenced_tweets`
    + `&expansions=author_id,attachments.media_keys`
    + `&user.fields=username&media.fields=url,preview_image_url`
    + (since ? `&since_id=${since}`
             : `&start_time=${new Date(fromMs).toISOString()}`);

  const data = [], users = {}, media = {};
  let token = null, page = 0, newest = null, complete = true;
  do{
    const r = await fetch(base + (token ? `&next_token=${token}` : ''),
                          { headers:{ Authorization:`Bearer ${process.env.X_BEARER}` }});
    if(!r.ok){
      const body = await r.text();
      console.error('[X] search failed', r.status, `page ${page+1}`, body);
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
      complete = false;
      break;
    }
    const j = await r.json();
    if(page === 0) newest = j.meta?.newest_id || null;
    (j.includes?.users||[]).forEach(u => { users[u.id] = u.username; });
    (j.includes?.media||[]).forEach(m => { media[m.media_key] = m.url || m.preview_image_url; });
    data.push(...(j.data||[]));
    token = j.meta?.next_token || null;
    page++;
  } while(token && page < X_MAX_PAGES);

  if(token){
    complete = false;
    console.log(`[X] ${X_MAX_PAGES*100} 件で止めました。残りは次の巡回で読みます。`);
  }
  /* 全部読めたときだけ印を進める。途中で止まったら、次の巡回で同じ窓を読み直す。 */
  if(complete && newest) state.xSince = newest;
  if(complete) state.xAt = startedAt.toISOString();
  if(page > 1) console.log(`[X] ${page} ページ・${data.length} 件を読みました。`);
  if(!data.length) return [];

  const ref = (t,type) => (t.referenced_tweets||[]).find(r=>r.type===type)?.id || null;
  return data.map(t => ({
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
/* Threads は無料なので、件数では絞らない（上限は Meta のレート制限だけ）。

   入口は二つ。
   ① 検索（タグとメンション）。ただし threads_keyword_search の審査が通るまでは
      @alembicity 自身の投稿しか返らない。審査が通れば、このままで他人の投稿も拾う。
   ② 運営の手によるリポスト・引用。@alembicity がリポスト（または引用）した他人の投稿を、
      受理された観測として扱う。タグが付いていなくてよい。リポストそのものが受理の印。
      観測者は元の投稿者。番号も元の投稿者に付く。

   Threads の画像URLは署名つきで、数日で期限が切れる。
   ②で見えている投稿は巡回のたびに新しいURLを返すので、既知の観測の img を差し替える（refreshThreadsImages）。 */
const TH_API = 'https://graph.threads.net/v1.0';
const TH_MAX_PAGES = 20;            // 一つの問い合わせで辿るページの上限（暴走止め）
const TH_REPOST_DAYS = 60;          // リポストを遡る日数。画像URLの差し替えもこの範囲
const TH_MEDIA = 'id,text,permalink,username,timestamp,media_type,media_url,thumbnail_url,children';

function thUrl(path, params = {}){
  const u = new URL(TH_API + path);
  for(const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('access_token', process.env.THREADS_TOKEN);
  return u.toString();
}
async function thGet(url){
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(`${r.status} ${j?.error?.message || ''}`.trim());
  return j;
}
/* paging.next を辿って全部読む */
async function thAll(url, label){
  const out = [];
  let next = url, page = 0;
  while(next && page < TH_MAX_PAGES){
    const j = await thGet(next);
    out.push(...(j.data || []));
    next = j.paging?.next || null;
    page++;
  }
  if(next) console.log(`[Threads] ${label} は ${TH_MAX_PAGES} ページで止めました。`);
  return out;
}
/* 写真を一枚選ぶ。動画はサムネイル、カルーセルは一枚目 */
async function thImage(t){
  if(t.media_type === 'VIDEO') return t.thumbnail_url || null;
  if(t.media_url) return t.media_url;
  const first = t.children?.data?.[0]?.id;
  if(!first) return null;
  try{
    const c = await thGet(thUrl('/' + first, { fields:'media_type,media_url,thumbnail_url' }));
    return c.media_type === 'VIDEO' ? (c.thumbnail_url || null) : (c.media_url || null);
  }catch{ return null; }
}
async function thPost(t, via){
  return {
    src:'threads', id:`th:${t.id}`, raw:t.id, url:t.permalink,
    handle:t.username || null, text:t.text || '', at:t.timestamp,
    img: await thImage(t), via,
  };
}

/* Threads への返信。X と違って「コンテナを作る→公開する」の二段になる。
   トークンに threads_manage_replies と threads_content_publish が無いと、
   ①で 400/403 が返るだけなので、投稿は一切されず static log のみになる。
   CFG.POST.threadsReply が false のうちは①にすら行かない（準備だけしておく状態）。 */
async function thReply(replyToId, text){
  if(CFG.DRY || !CFG.POST.threadsReply || !process.env.THREADS_TOKEN){
    console.log('[Threads reply]', replyToId, JSON.stringify(text),
                CFG.DRY ? '(DRY_RUN)' : (CFG.POST.threadsReply ? '(トークン未設定)' : '(threadsReply=false)'));
    return null;
  }
  try{
    const create = await fetch(thUrl('/me/threads', {
      media_type:'TEXT', text, reply_to_id:replyToId,
    }), { method:'POST' });
    const cj = await create.json().catch(() => ({}));
    if(!create.ok || !cj.id){
      console.error('[Threads reply] container failed', create.status, cj?.error?.message || '');
      return null;
    }
    await new Promise(s => setTimeout(s, 2000));   // 公開前に少し待つ（Threadsの作法）
    const pub = await fetch(thUrl('/me/threads_publish', { creation_id: cj.id }), { method:'POST' });
    const pj = await pub.json().catch(() => ({}));
    if(!pub.ok){
      console.error('[Threads reply] publish failed', pub.status, pj?.error?.message || '');
      return null;
    }
    return pj.id || null;
  }catch(e){
    console.error('[Threads reply] failed', e.message);
    return null;
  }
}

async function fetchThreads(){
  if(!process.env.THREADS_TOKEN) return [];
  const out = new Map();

  /* ① 検索。タグ検索は search_mode=TAG で、q に # を付けない。
     # を付けたままキーワード検索すると、タグ付き投稿は拾えず空が返る。 */
  const queries = [
    { q: CFG.TAG,          mode: 'TAG'     },
    { q: '@'+CFG.ACCOUNT,  mode: 'KEYWORD' },
  ];
  for(const { q, mode } of queries){
    try{
      const list = await thAll(thUrl('/keyword_search', {
        q, search_type:'RECENT', search_mode:mode, limit:'100', fields:TH_MEDIA,
      }), `検索 ${mode}`);
      for(const t of list) if(!out.has(t.id)) out.set(t.id, await thPost(t, 'search'));
    }catch(e){ console.error('[Threads] 検索できません', mode, q, e.message); }
  }

  /* ② @alembicity のリポスト・引用 */
  let mine = [];
  try{
    /* since は付けない。リポストの時刻の扱いが投稿と同じとは限らないため、
       新しい順に読んで、古いものは手元で落とす。 */
    const cutoff = Date.now() - TH_REPOST_DAYS*864e5;
    mine = (await thAll(thUrl('/me/threads', {
      fields:'id,media_type,timestamp,reposted_post,quoted_post,is_quote_post',
      limit:'100',
    }), '自分の投稿')).filter(m => !m.timestamp || Date.parse(m.timestamp) >= cutoff);
  }catch(e){ console.error('[Threads] 自分の投稿を読めません', e.message); }
  /* 一覧では reposted_post が付いてこない。REPOST_FACADE は一件ずつ聞き直す。 */
  for(const m of mine){
    if(m.media_type !== 'REPOST_FACADE' || m.reposted_post) continue;
    try{
      /* 元が伏せられる場合に備えて、見えるかもしれない欄を全部聞く（診断を兼ねる） */
      const one = await thGet(thUrl('/' + m.id, {
        fields:'id,media_type,reposted_post,permalink,shortcode,username,text,media_url,thumbnail_url,timestamp,children' }));
      if(one.reposted_post) m.reposted_post = one.reposted_post;
      else console.log('[Threads] リポストの元が返りません', m.id, JSON.stringify(one));
    }catch(e){ console.error('[Threads] リポストを読めません', m.id, e.message); }
  }
  {
    const kinds = {};
    for(const m of mine) kinds[m.media_type || '?'] = (kinds[m.media_type || '?'] || 0) + 1;
    console.log(`[Threads] 自分の投稿 ${mine.length} 件（${Object.entries(kinds).map(([k,v])=>`${k} ${v}`).join('・') || 'なし'}）`
      + ` ／ リポスト印 ${mine.filter(m=>m.reposted_post).length} ・引用印 ${mine.filter(m=>m.quoted_post).length}`);
  }

  const refs = [...new Set(mine.flatMap(m => [m.reposted_post, m.quoted_post])
    .map(x => x && (x.id || x)).filter(Boolean))];
  let got = 0, failed = 0;
  for(const id of refs){
    try{
      const t = await thGet(thUrl('/' + id, { fields:TH_MEDIA }));
      if(t.username === CFG.ACCOUNT) continue;          // 自分の投稿のリポストは数えない
      out.set(t.id, await thPost(t, 'repost'));
      got++;
    }catch(e){
      failed++;
      if(failed === 1) console.error('[要対応] Threads のリポスト先が読めません', id, e.message);
    }
  }
  if(refs.length) console.log(`[Threads] リポスト・引用 ${refs.length} 件（読めた ${got} ／ 読めない ${failed}）`);
  return [...out.values()];
}

/* 診断（読むだけ）。一日一回。
   公開リポジトリのログは誰でも読めるので、名前や本文は出さず、件数と権限名だけを出す。
     ・トークンが持っている権限（threads_read_replies / threads_manage_replies があるか）
     ・@alembicity 自身の投稿への返信のうち、自分以外の返信が何件見えるか
       （開発モードで他人の返信が見えるなら、審査を待たずに「受付ポストへの返信」で取り込める） */
async function thDiagnose(state){
  if(!process.env.THREADS_TOKEN) return;
  const day = new Date().toISOString().slice(0, 10);
  if(state.thDiagDay === day) return;
  state.thDiagDay = day;
  try{
    const u = new URL(TH_API + '/debug_token');
    u.searchParams.set('input_token', process.env.THREADS_TOKEN);
    u.searchParams.set('access_token', process.env.THREADS_TOKEN);
    const j = await thGet(u.toString());
    const d = j.data || j;
    console.log(`[Threads診断] 権限 ${(d.scopes || []).join(',') || '（取得できず）'}`
      + (d.expires_at ? ` ／ 期限 ${new Date(d.expires_at * 1000).toISOString().slice(0, 10)}` : ''));
  }catch(e){ console.log('[Threads診断] 権限を読めません', e.message); }
  try{
    const mine = (await thGet(thUrl('/me/threads', { fields:'id,media_type', limit:'10' }))).data || [];
    const roots = mine.filter(m => m.media_type !== 'REPOST_FACADE').slice(0, 5);
    let all = 0, others = 0, failed = 0;
    for(const m of roots){
      try{
        const r = (await thGet(thUrl('/' + m.id + '/replies', { fields:'id,username', limit:'100' }))).data || [];
        all += r.length;
        others += r.filter(x => x.username && x.username !== CFG.ACCOUNT).length;
      }catch(e){
        if(!failed) console.log('[Threads診断] 返信を読めません', e.message);
        failed++;
      }
    }
    console.log(`[Threads診断] 自分の投稿 ${roots.length} 件への返信 ${all} 件（うち他人 ${others} 件）`
      + (failed ? ` ／ 読めない ${failed} 件` : ''));
  }catch(e){ console.log('[Threads診断] 自分の投稿を読めません', e.message); }
}

/* 既知の Threads 観測の画像URLを、いま見えている新しいものに差し替える。
   期限切れで褪色に落ちていたものは、元の投稿が見えている以上は戻す。 */
function refreshThreadsImages(obs, posts){
  const now = new Map(posts.filter(p => p.src === 'threads' && p.img).map(p => [p.id, p.img]));
  let n = 0;
  for(const o of obs){
    const img = now.get(o.id);
    if(!img) continue;
    if(o.img !== img){ o.img = img; n++; }
    if(o.state === 'faded') o.state = 'ok';
  }
  if(n) console.log(`[Threads] 画像URLを ${n} 件差し替えました。`);
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
function read(post, observers, state, acks){
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
            && !observers.used.includes(n)
            && !isFrozen(state, n);
    if(ok){
      observers.claim = observers.claim || {};
      observers.claim[post.handle.toLowerCase()] = n;
      if(state && state.keyMiss) delete state.keyMiss[n];   /* 通ったら外れの数は忘れる */
    } else if(said || v <= CFG.LOCAL_TO){
      console.log(`[名乗り] ${n} は通しませんでした（範囲・鍵・使用済み・凍結のいずれか）。`);
      /* 鍵つきで外した場合だけ数える。番号だけの打ち間違いは数えない */
      if(want && said && !observers.used.includes(n)) noteMiss(state, n, said.key);
    }
  }

  /* 名簿の欄。番号は本文から取らない。issueNumber が返す番号にだけ書く。
     つまり他人の番号を指名して書き換える経路は存在しない。 */
  const prof = readProfile(text);
  const { num, isNew, from, key } = issueNumber(observers, post.handle);
  applyProfile(observers, num, prof, post, CFG.LOCAL_FROM);
  noteAck(acks, num, prof, post, CFG.LOCAL_FROM);
  /* 鍵は本文から必ず落とす。盤にもフィルム片にも残さない。 */
  const body = stripKey(prof.rest, said);

  const tx = body.replace(COORD_RE,'').replace(SEED_RE,'').replace(NUM_RE,'')
    .replace(/@\S+/g,'').replace(/#\S+/g,'').replace(/https?:\/\/\S+/g,'')
    .replace(/[ \u3000]{2,}/g,' ').trim();   // タグを抜いた跡の二重空白を潰す

  const three = threeLines(body);
  return {
    coord: cm ? `${cm[1]}/${cm[2]}` : null,
    seed : sm ? `${sm[1]}${sm[2]}_${sm[3]}${sm[4]}` : null,
    num, isNew, from, key, tx,
    obs: { id:post.id, src:post.src, by:num, state:'ok', kind:'photo', yr:'',
           permalink:post.url, at:post.at, tx, img:post.img || null, words:[],
           hint: phenomenonOf(prof.rest),   /* 現象の見立て。処置が確定させるまでは提案 */ 
           then: three.then || null, now: three.now || null, first: three.first || null,
           coord:null, seed:null, handle:post.handle || null, raw_text:body },
    word:{ id:post.id, by:num, state:'ok', tx, permalink:post.url, at:post.at,
           then: three.then || null, now: three.now || null },
  };
}

/* ------------------------------------------------------------ decay ------- */
/* 巡回のたびに画像と permalink を叩き、消えていれば褪色・欠落に落とす。
   運営が消すのではなく、放っておいたら褪せる。リンク切れが世界の物理法則になる。

   ただし「消えた」と言い切るのは慎重にする。欠落は戻らないので、誤って落とすと記録が死ぬ。
   ・X の投稿ページは、ログインしていない巡回機に 404 を返すことがある。
     2026-09、木戸蓮の UMK0001〜0007 は投稿が残っているのに欠落になった。
     だから X の 404 は「候補」に留め、API で本当に無い（resource-not-found）ときだけ欠落にする。
     残っていると確かめたものは七日間は聞き直さない（読み取りの課金を増やさない）。
   ・X 以外は、二回続けて 404 のときだけ欠落にする。
   ・確かめられなかったときは、状態を動かさない。 */
const LOST_AFTER = 2;
const X_RECHECK_MS = 7 * 24 * 3600 * 1000;

/* 本当に存在しない X の投稿 id の Set。確かめられなければ null */
async function xGone(ids){
  if(!ids.length) return new Set();
  if(!process.env.X_BEARER) return null;
  const gone = new Set();
  for(let i = 0; i < ids.length; i += 100){
    const chunk = ids.slice(i, i + 100);
    const r = await fetch(`https://api.x.com/2/tweets?ids=${chunk.join(',')}`,
      { headers:{ Authorization:`Bearer ${process.env.X_BEARER}` }});
    if(!r.ok){ console.error('[褪色] X で確かめられませんでした', r.status); return null; }
    const j = await r.json();
    for(const e of (j.errors || [])){
      if(/resource-not-found/.test(e.type || '') && e.resource_id) gone.add(String(e.resource_id));
    }
  }
  return gone;
}

async function decay(obs){
  const ask = [];                       /* X で 404 が出たもの。API で確かめる */
  const now = Date.now();
  for(const o of obs){
    if(o.state === 'lost'){
      /* 旧方式（404 一回で欠落）で落ちた X の観測は、一度だけ API で確かめ直す。
         残っていれば戻す。戻った観測は tally に入るので、この回で盤が割れることがある。 */
      if(o.src === 'x' && !o.lostChecked) ask.push(o);
      continue;
    }
    try{
      /* 写しを持っている期限つきの画像は、URLが切れても褪色にしない。
         消えたかどうかは permalink で判断する。 */
      if(o.img && !(o.frame && o.src !== 'x')){
        const r = await fetch(o.img, { method:'HEAD' });
        if(!r.ok && o.state === 'ok') o.state = 'faded';
      }
      if(o.permalink){
        const r = await fetch(o.permalink, { method:'HEAD', redirect:'follow' });
        if(r.status === 404){
          if(o.src === 'x'){
            if(!(o.xSeen && now - Date.parse(o.xSeen) < X_RECHECK_MS)) ask.push(o);
          } else if((o.miss = (o.miss || 0) + 1) >= LOST_AFTER){
            o.state = 'lost';
          }
        } else if(r.ok){
          delete o.miss;
        }
      }
    }catch{ /* 一時的な失敗で消さない。次の現像で判定する */ }
  }
  if(!ask.length) return;
  const idOf = o => String(o.id || '').replace(/^x:/, '');
  let gone = null;
  try{ gone = await xGone(ask.map(idOf)); }catch(e){ console.error('[褪色]', e.message); }
  if(!gone) return;
  for(const o of ask){
    if(gone.has(idOf(o))){
      o.state = 'lost';
      o.lostChecked = true;
    } else {
      if(o.state === 'lost'){
        o.state = 'ok';
        o.lostChecked = true;
        console.log(`[褪色] ${o.aid || o.id} は投稿が残っていたので欠落から戻します`);
      }
      o.xSeen = new Date(now).toISOString();
    }
  }
}

/* 画像の写し。900×600（一葉の大きさ）に中央で切って data/frames/ に置く。 */
async function keepFrame(o){
  try{
    const r = await fetch(o.img);
    if(!r.ok) return null;
    const { default: sharp } = await import('sharp');
    const buf = await sharp(Buffer.from(await r.arrayBuffer())).rotate()
      .resize(900, 600, { fit:'cover', position:'centre' }).jpeg({ quality:80 }).toBuffer();
    const name = `frames/${String(o.id).replace(/[^A-Za-z0-9_-]/g, '-')}.jpg`;
    await fs.mkdir(P('frames'), { recursive:true });
    await fs.writeFile(P(name), buf);
    console.log(`[写し] ${o.aid || o.id} ${Math.round(buf.length/1024)}KB`);
    return name;
  }catch(e){ console.error('[写し] 失敗', o.id, e.message); return null; }
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
const acks      = await load('join-ack.json', {});   // 合流符の目撃。受付が突き合わせる
const observers = await load('observers.json', { byName:{}, used:[], claim:{}, next:CFG.WEB_FROM });
const obs       = await load('observations.json', []);
const plates    = await load('plates.json', {});
const seeds     = await load('seeds.json', {});          // 地点キー → 観測数
const places    = await load('places.json', {});         // 町名 → 緯度経度（育つ辞書）
const archive   = await load('archive.json', {});        // 接頭辞 → 最後に使った番号
const boards    = await load('boards.json', []);         // 命名済みの盤（bounds は凍結）
const pending   = await load('boards-pending.json', []); // 生まれたが、まだ名の無い盤

/* ---- 一度きりの移し替え（2026-09-11、運営の指示）-----------------------------
   UMK0001〜0011 を小説からの引用（連載記録 UMEKOJI）に空ける。
   それより前に機械が振っていた八件を、受理の古い順のまま UMK0012〜0019 へ移す。
     木戸蓮（@kid0ren）の X 投稿 七件 → UMK0012〜0018
     9/7 の X 投稿 一件               → UMK0019
   id で指名し、今の番号が想定どおりのときだけ動かす。二度目は走らない。
   「番号は二度と変えない」の唯一の例外。以後の移し替えも、必ずこの形で残すこと。 */
const MOVE_2026_09_11 = {
  'x:2091829156350980144': ['UMK0001', 'UMK0012'],
  'x:2091871558293979317': ['UMK0002', 'UMK0013'],
  'x:2091873031484481717': ['UMK0003', 'UMK0014'],
  'x:2091873552542974421': ['UMK0004', 'UMK0015'],
  'x:2091874203406582226': ['UMK0005', 'UMK0016'],
  'x:2091876070090023283': ['UMK0006', 'UMK0017'],
  'x:2091877376699568558': ['UMK0007', 'UMK0018'],
  'x:2096954255848694102': ['UMK0008', 'UMK0019'],
};
state.moves = state.moves || [];
if(!state.moves.includes('2026-09-11-umk')){
  let moved = 0;
  for(const o of obs){
    const m = MOVE_2026_09_11[o.id];
    if(m && o.aid === m[0]){ o.aid = m[1]; moved++; }
  }
  archive.UMK = Math.max(archive.UMK || 0, 19);
  state.moves.push('2026-09-11-umk');
  console.log(`[番号] 一度きりの移し替え ${moved} 件（UMK0001〜0011 を小説に空けた）`);
}
const seen      = new Set([...obs.map(o=>o.id), ...obs.flatMap(o=>(o.words||[]).map(w=>w.id))]);

const thPosts = await fetchThreads();
refreshThreadsImages(obs, thPosts);
await thDiagnose(state);
const posts = [
  ...await fetchX(state),
  ...thPosts,
  ...await fetchInstagramQueue(),
].filter(p => !seen.has(p.id));

/* ---- 町名を座標に翻訳する --------------------------------------------------
   #下京区朱雀宝蔵町 のような、人が手で打てるタグを受けるための一手間。
   本文は変えない。末尾に座標タグを一つ足すだけで、あとは既存の読み取りに任せる。
   一度引いた町名は places.json に残り、二度目からは回線を使わない。 */
const geoBudget = { left: 40 };   /* 一回の現像で住所検索に尋ねる上限 */
for(const p of posts){
  /* 「場所 下京区朱雀宝蔵町」「場所 E6」── タグを増やさずに場所を書く一行。
     行は本文から外し、内部でだけタグの形にして既存の読み取りに渡す（外に見えるタグは増えない）。 */
  const pl = placeLine(p.text || '');
  if(pl){ p.text = pl.rest + ' ' + pl.tag; console.log(`[場所] ${pl.value} → ${pl.tag}`); }
  const found = await locateText(p.text || '', places, geoBudget);
  if(!found) continue;
  p.text = `${p.text} ${found.tag}`;
  console.log(`[places] ${found.name} → ${found.tag}${found.cached ? '' : '（照会）'}`);
}

const before = tallyOf(obs);
const fresh = [], words = [], located = [], postscripts = [], unresolved = [], wikiPs = [];
const byId = new Map(obs.map(o => [o.id, o]));

/* センターの放送 → 記録 の対応。放送への返信を、正しい記録に付けるために覚えておく。
   一本に一件（一葉・照合・開区）なら、その記録。
   現像（フィルム片）は四件まで並ぶので、返信の本文に記録番号（UMK0012 など）か
   その下四桁があるときだけ、その記録に付ける。無ければ宛先不明として人が直す。 */
state.relay = state.relay || {};
function relayTarget(pid, text){
  const ids = [].concat(state.relay[pid] || []);
  if(!ids.length) return null;
  const cand = ids.map(id => byId.get(id)).filter(Boolean);
  if(cand.length === 1) return cand[0];
  const t = String(text || '').normalize('NFKC').toUpperCase();
  const hit = cand.filter(o => o.aid && (t.includes(o.aid) || new RegExp('(?<!\\d)' + o.aid.slice(-4) + '(?!\\d)').test(t)));
  return hit.length === 1 ? hit[0] : null;
}
function remember(postedId, obsIds){
  if(!postedId) return;
  state.relay['x:' + postedId] = obsIds;
  const keys = Object.keys(state.relay);
  if(keys.length > 400) for(const k of keys.slice(0, keys.length - 400)) delete state.relay[k];
}

for(const p of posts){
  const c = read(p, observers, state, acks);
  if(c.from) migrateNumber(obs, c.from, c.num);   // 乗り換え。旧番号の記録を引き継ぐ
  // 返信・引用の相手が、こちらの知っている観測かどうか。
  // センターの放送（一葉・照合の一枚・開区・現像）への返信も、その記録への返信として解く。
  const parent = p.parent ? (byId.get(p.parent) || relayTarget(p.parent, c.obs.raw_text)) : null;

  /* --- 0. 追伸 ＝ すでに受理された記録に、あとから言葉を足す -------------
     #追伸 を書いた投稿に加えて、**番号の付いた記録への写真つきの返信・引用** も追伸にする。
     これを新しい観測にしてしまうと、照合の一枚になるはずの写真に別の番号が振られる。 */
  const named = PS_RE.test(c.obs.raw_text || '') ? null : aidInText(c.obs.raw_text, obs);
  const wikiAid = parent ? null : wikiOnlyAid(c.obs.raw_text, obs);
  if(wikiAid){
    wikiPs.push({ id:p.id, aid:wikiAid, by:c.num, name:(observers.profile || {})[c.num]?.name || null,
                  tx:c.tx.replace(new RegExp(AID_RE.source, 'gi'), '').trim(),
                  then:c.obs.then || null, now:c.obs.now || null, code:c.obs.hint || null,
                  at:p.at, url:p.url || null, img:p.img || null });
    postscripts.push({ aid:wikiAid, by:c.num, at:p.at });
    continue;
  }
  if(PS_RE.test(c.obs.raw_text || '') || named || (p.img && parent && parent.aid)){
    const t = named || postscriptTarget(c.obs.raw_text, parent, obs);
    if(t && t.aid){
      t.post = t.post || [];
      if(!t.post.some(x => x.src === p.id)){       /* 再実行で二重に積まない */
        t.post.push({ by:c.num, tx:named ? c.tx.replace(new RegExp(AID_RE.source, 'gi'), '').trim() : c.tx,
                      hint:c.obs.hint || null,
                      then:c.obs.then || null, now:c.obs.now || null,
                      at:p.at, src:p.id, via:p.src,
                      permalink:p.url || null, img:p.img || null });
        postscripts.push({ aid:t.aid, by:c.num, at:p.at });
        /* 照合：写真つきの追伸が届いた。元の記録に写真があれば、現像で記述と現況を並べる */
        if(p.img){
          state.pairQueue = state.pairQueue || [];
          if(!state.pairQueue.some(q => q.src === p.id)) state.pairQueue.push({ aid:t.aid, src:p.id });
        }
      }
      continue;                                    /* 記録の state は変えない */
    }
    if(!p.img){
      /* 宛先が分からない追伸。捨てない。盤に出して人が直せるようにする */
      unresolved.push({ src:p.id, by:c.num, tx:c.tx, at:p.at, permalink:p.url || null });
      continue;
    }
    /* 写真つきで宛先も分からないなら、ふつうの観測として下へ落とす */
  }

  /* --- 1. 写真がある ＝ 観測 ------------------------------------------- */
  if(p.img){
    const o = { ...c.obs, coord:c.coord, seed:c.seed };
    if(!o.aid) o.aid = issueAid(archive, o.coord || o.seed);   /* 一度だけ。以後は動かさない */
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
  if(target){
    target.words.push(c.word); words.push(c.word);
    /* 返信・引用で付いた言葉は、その記録の追伸欄にも並べる（③ 返信するだけで追伸になる）。
       盤の言葉（words）と記録票の追伸（post）は、読む場所が違うだけで同じ一言。 */
    if(parent && target === parent && target.aid){
      target.post = target.post || [];
      if(!target.post.some(x => x.src === p.id)){
        target.post.push({ by:c.num, tx:c.tx, hint:c.obs.hint || null,
                           then:c.obs.then || null, now:c.obs.now || null,
                           at:p.at, src:p.id, via:p.src, permalink:p.url || null, img:null });
        postscripts.push({ aid:target.aid, by:c.num, at:p.at });
      }
    }
  }
}

/* 未定位の観測。漂ったまま盤に載り、誰かが座標を付けるのを待つ。 */
const drifting = obs.filter(o => o.state !== 'lost' && !o.coord && !o.seed);

/* Threads・Instagram の画像URLは署名つきで数日で切れる。
   焼く順番が何日も先になっても焼けるように、受理した時点で一枚だけ手元に写しておく。
   X の画像は投稿が残る限り読めるので写さない（リポジトリを太らせない）。 */
for(const o of obs){
  if(o.src === 'x' || o.frame || !o.img || o.state === 'lost') continue;
  const f = await keepFrame(o);
  if(f) o.frame = f;
}

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
    if(o.src === 'x'){
      /* 2026-02 以降、X は「相手が @alembicity を書いた投稿」にしか API で返信させない。
         書いていない投稿へ投げても 403 になるだけなので、数えずに飛ばす。番号は束ね投稿と名簿で届く。 */
      if(!MENTION_RE.test(o.raw_text || '')) continue;
      if(CFG.POST.reply === 'first' && !o.isNew) continue;
      if(state.replies[day] >= CFG.POST.replyDailyCap) break;
      const k = o.key || keyOf(observers, o.by);
      const named = (observers.profile || {})[o.by]?.name;
      await xPost({ text:`観測員${o.by}号。記録しました。`
                    + (k ? `\n鍵は ${k} です。控えておいてください。` : '')
                    + (named ? '' : `\n名乗るときは、次の報告の末尾に「観測員 呼び名」と一行添えてください。`)
                    + `\nここからはもう返しません。盤で確かめてください。`,
                    reply:{ in_reply_to_tweet_id:o.id.slice(2) } }, 'reply');
      state.replies[day]++;
    } else if(o.src === 'threads'){
      /* threadsReply が false の間はここに来ても thReply が即座にログだけ出して抜ける。
         審査が通って true にした瞬間、X と同じ条件（初回のみ・日次上限）でそのまま動き出す。 */
      if(CFG.POST.reply === 'first' && !o.isNew) continue;
      if(state.replies[day] >= CFG.POST.replyDailyCap) break;
      const k = o.key || keyOf(observers, o.by);
      await thReply(o.raw, `観測員${o.by}号。記録しました。`
                    + (k ? `\n鍵は ${k} です。控えておいてください。` : '')
                    + `\nここからはもう返しません。盤で確かめてください。`);
      state.replies[day]++;
    }
  }
}

/* 2) 現像ごとに1本だけ出す。投稿数は日4本が上限で、観測が何件来ても増えない。
      4コマをフィルム片1枚に焼くので、縦横がばらばらでも見た目が毎回同じになり、
      アップロードするメディアも1件で済む。
      Instagram から来た観測をここに混ぜることで、X 上に言葉が付く先ができる。

      5件目からは state.stripQueue に並べ、次の現像で古い順に4件ずつ焼く。
      投稿が通ったぶんだけ列から外す（書き込みが失敗した回は、同じ4件が次に回る）。
      褪色・欠落したものは列から落とす。日数では落とさない。盤には最初から全件載っている。 */
/* 2026-09-16 運営の指示：日数では落とさない。焼けなかった分は、一回4件のまま先へ先へと送る。
   落とすのは褪色・欠落・#再掲不可 になったものだけ。 */
state.stripQueue = state.stripQueue || [];
const relayable = o => !!o && o.state === 'ok' && !!(o.img || o.frame)
  && !CFG.NO_RELAY_RE.test(o.raw_text || '')          // #再掲不可 は焼かない
  && (CFG.POST.relayInstagram || o.src !== 'instagram');
{
  const inQueue = new Set(state.stripQueue);
  [...fresh].sort((a, b) => String(a.at).localeCompare(String(b.at))).forEach(f => {
    if(!inQueue.has(f.id) && relayable(byId.get(f.id))){ state.stripQueue.push(f.id); inQueue.add(f.id); }
  });
  state.stripQueue = state.stripQueue.filter(id => relayable(byId.get(id)));
}

if(CFG.POST.develop && state.stripQueue.length){
  const pick = state.stripQueue.slice(0, 4).map(id => byId.get(id));

  let media = [];
  if(CFG.POST.strip && pick.length){
    try{
      const buf = await buildStrip(
        pick.map(o=>({ img:o.img, file:o.frame ? P(o.frame) : null, coord:o.coord || o.seed || 'UNLOCATED',
                       by:o.by, handle:o.handle })),
        at, CFG.ACCOUNT);
      const id = await xUploadMedia(buf, 'strip.jpg');
      if(id) media = [id];
      await fs.mkdir(P('strips'),{recursive:true});
      await fs.writeFile(P(`strips/${at.replace(/[: ]/g,'-')}.jpg`), buf);  // 焼いた分は残す
    }catch(e){ console.error('[strip] 失敗', e.message); }
  }

  const lines = pick.map(o=>`${o.aid ? o.aid + ' ' : ''}${o.coord || o.seed || '位置未定'} ／ ${o.by}号`).join('\n');
  const rest  = state.stripQueue.length - pick.length;
  const more  = rest ? `\nほか ${rest} 件は、次の現像に回します。` : '';
  const unloc = pick.filter(o=>!o.coord && !o.seed).length;
  // 未定位があるときは「どこか分かる人がいたら教えてほしい」を必ず添える。
  // これがいちばん摩擦の低い参加口で、しかも会話が生まれる。
  const call  = unloc
    ? `\n位置の分からない写真が ${unloc} 枚あります。心当たりがあれば、返信で座標を書いてください。`
    : `\n言葉を足すときは、記録番号を添えてこの投稿に返信してください。座標は要りません。`;
  // 位置が決まった写真があれば、その報せを同じ一本に載せる。
  // 別の投稿にしないのは費用のため。事件は本文の中でも十分伝わる。
  const found = located.length
    ? '\n\n' + located.slice(0,3).map(l=>`${l.o.coord} の位置が決まりました。${l.by}号が見つけました。`).join('\n')
    : '';
  const posted = await xPost({
    text: `現像しました。\n${lines}${more}${call}${found}`,
    ...(media.length ? { media:{ media_ids: media } } : {}),
  }, 'develop');
  if(posted){
    remember(posted, pick.map(o => o.id));
    state.stripQueue.splice(0, pick.length);
  } else if(!CFG.DRY){
    console.log(`[現像] 投稿できなかったので、${pick.length} 件を列に残しました（待ち ${state.stripQueue.length} 件）。`);
  }
}

/* 2b) 二次現像 ── 言葉が焼き込まれた一葉。
      六時間ごとの現像は写真だけ（写真が先に来る）。
      言葉が付いた観測は、一日一回この形で出す。これが「説明が拡散していく」経路。
      引用でも返信でもなく、言葉そのものが画像になって外へ出るので、
      読んだ人は元の投稿を開かなくても、何を見てどう語られたかが分かる。 */
/* cron は数時間遅れて走るので「9時ちょうど」には当たらない。
   その日（UTC）の leafHour 以降で、まだ出していない最初の回に出す。 */
const leafDue = new Date().getUTCHours() >= CFG.POST.leafHour && state.leafDay !== day;
if(CFG.POST.develop && leafDue){
  const worded = obs
    .filter(o => o.state !== 'lost' && (o.img || o.frame) && (o.words||[]).some(w=>w.state!=='lost' && w.tx))
    .filter(o => !CFG.NO_RELAY_RE.test(o.raw_text || ''))
    .filter(o => !state.leafed?.includes(o.id))
    .sort((a,b)=> (b.words?.length||0) - (a.words?.length||0));
  const o = worded[0];
  if(o){
    try{
      const buf = await buildLeaf({
        img:o.img, file:o.frame ? P(o.frame) : null,
        coord:o.coord || o.seed || 'UNLOCATED', by:o.by, handle:o.handle, at,
        tx:o.tx, words:(o.words||[]).filter(w=>w.state!=='lost' && w.tx),
      }, CFG.ACCOUNT);
      const id = await xUploadMedia(buf, 'leaf.jpg');
      await fs.mkdir(P('leaves'),{recursive:true});
      await fs.writeFile(P(`leaves/${o.id.replace(/[:\/]/g,'-')}.jpg`), buf);
      const leafId = await xPost({
        text: `${o.coord || o.seed || '位置未定の観測'} に言葉が付きました。\n観測 ${o.by}号 ／ 言葉 ${(o.words||[]).map(w=>w.by+'号').join('・')}`,
        ...(id ? { media:{ media_ids:[id] } } : {}),
      }, 'leaf');
      remember(leafId, [o.id]);
      state.leafed = [...(state.leafed||[]), o.id];
      state.leafDay = day;
    }catch(e){ console.error('[leaf] 失敗', e.message); }
  }
}

/* 2c) 照合 ── 記述と現況が一枚に並ぶとき。
      写真のある記録に、写真つきの追伸（#追伸UMK0012 など）が届いたら、
      左に記述（元の記録の一枚）、右に現況（追伸の一枚）を焼いて出す。一回に一本まで。
      投稿が通ったら列から外す。三度失敗したものは落とす。 */
state.pairQueue = state.pairQueue || [];
if(CFG.POST.develop && CFG.POST.pair && state.pairQueue.length){
  const q = state.pairQueue[0];
  const t = obs.find(o => o.aid === q.aid);
  const p = t && (t.post || []).find(x => x.src === q.src);
  const ok = t && p && p.img && (t.img || t.frame) && t.state !== 'lost'
          && !CFG.NO_RELAY_RE.test(t.raw_text || '');
  if(!ok){
    state.pairQueue.shift();
  } else {
    let posted = null;
    try{
      const buf = await buildPair(
        { img:t.img, file:t.frame ? P(t.frame) : null, by:t.by, handle:t.handle },
        { img:p.img, by:p.by },
        { aid:t.aid, coord:t.coord || t.seed || 'UNLOCATED', at }, CFG.ACCOUNT);
      const id = await xUploadMedia(buf, 'pair.jpg');
      await fs.mkdir(P('pairs'),{recursive:true});
      await fs.writeFile(P(`pairs/${t.aid}-${String(q.src).replace(/[:\/]/g,'-')}.jpg`), buf);
      const where = cellName(t.coord);
      posted = await xPost({
        text: `${t.aid} の照合が届きました。\n記録 ${t.by}号 ／ 照合 ${p.by}号`
            + (where ? `\n${where}` : '')
            + `\n左がかつての記憶、右がいまの姿です。不整合を見つけたら、返信で記述してください。`,
        ...(id ? { media:{ media_ids:[id] } } : {}),
      }, 'pair');
    }catch(e){ console.error('[pair] 失敗', e.message); }
    if(posted){ remember(posted, [t.id]); state.pairQueue.shift(); }
    else if(!CFG.DRY){
      q.tries = (q.tries || 0) + 1;
      if(q.tries >= 3){ console.log(`[照合] ${q.aid} を三度出せなかったので列から外しました。`); state.pairQueue.shift(); }
    }
  }
}

/* 2d) ○年前の今日 ── data/almanac.json に今日（JST）の日付があれば、一日一本。
      史料は出典のあるものだけを置く（運営が手で足す）。本文にハッシュタグを入れない
      （自分の投稿を取り込まないため）。 */
if(CFG.POST.almanac){
  const jst = new Date(Date.now() + 9*3600*1000);
  const md  = jst.toISOString().slice(5, 10);          // 'MM-DD'
  const jday = jst.toISOString().slice(0, 10);
  if(state.almanacDay !== jday){
    const book = await load('almanac.json', []);
    const hits = (Array.isArray(book) ? book : []).filter(e => e && e.md === md && e.year && e.tx);
    if(hits.length){
      const e = hits[(jst.getUTCFullYear()) % hits.length];
      const ago = jst.getUTCFullYear() - Number(e.year);
      const posted = await xPost({
        text: `${ago}年前の今日。\n${e.year}年${Number(md.slice(0,2))}月${Number(md.slice(3))}日、${e.tx}`
            + (e.cell ? `\n${cellName('KYOTO/' + e.cell)}` : '')
            + (e.src ? `\n出典：${e.src}` : '')
            + `\nいまの姿を確かめに行ける観測員を待っています。`,
      }, 'almanac');
      if(posted || CFG.DRY) state.almanacDay = jday;
    } else {
      state.almanacDay = jday;
    }
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

/* 3c) 開区 ── 盤の区画に、初めて観測が置かれたとき。64 区画を一つずつひらいていく。
      はじめて走る回は数えるだけで告げない（いまある区画を一斉に告げないため）。 */
{
  const cellOfObs = o => (/^KYOTO\/([A-H][1-8])/.exec(o.coord || '') || [])[1];
  const now = [...new Set(obs.filter(o => o.state !== 'lost').map(cellOfObs).filter(Boolean))];
  if(!Array.isArray(state.openCells)){
    state.openCells = now;
    console.log(`[開区] 数え始め：${now.join(' ') || 'なし'}`);
  } else if(CFG.POST.openCell){
    for(const code of now.filter(c => !state.openCells.includes(c))){
      const first = obs.filter(o => cellOfObs(o) === code)
                       .sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
      const posted = await xPost({
        text: `${cellName('KYOTO/' + code)}がひらきました。\n64区画のうち ${state.openCells.length + 1} 区画目。最初の観測は ${first?.by || '不明'}号です。\nこの区画の1200年の地層は、まだ誰も記述していません。`,
        ...(first?.src === 'x' ? { quote_tweet_id:first.id.slice(2) } : {}),
      }, 'open');
      if(posted){ remember(posted, first ? [first.id] : []); state.openCells.push(code); }
      else if(CFG.DRY) console.log(`[開区] ${code}（DRY_RUN のため印は付けない）`);
    }
  }
}

/* すでに受理されている観測に番号が無ければ、古い順に振る。
   仕組みを入れる前に受け付けた分の繰り上げ。一度きりで、
   番号を持っている記録には触らない。 */
obs.filter(o => !o.aid)
   .sort((x, y) => String(x.at || '').localeCompare(String(y.at || '')))
   .forEach(o => { o.aid = issueAid(archive, o.coord || o.seed); });

/* ---- 一度きりの振り直し ---------------------------------------------------
   接頭辞を三本立てにする前に発行された番号は、すべて XXX だった。
   盤の中の観測まで XXX を持っていて、接頭辞が最初から嘘をついていた。
   archive.json に版を刻み、版が古い回だけ、受理の古い順に振り直す。
   二度目は走らない。これ以降は永久に振り直さない。
   出回った番号を動かすと、その番号を指した追伸の宛先が消えるから。 */
const ARCHIVE_V = 2;
if(archive.v !== ARCHIVE_V){
  for(const k of Object.keys(archive)) delete archive[k];
  archive.v = ARCHIVE_V;
  obs.slice()
     .sort((x, y) => String(x.at || '').localeCompare(String(y.at || '')))
     .forEach(o => { o.aid = issueAid(archive, o.coord || o.seed); });
  console.log('[番号] 一度きりの振り直し', JSON.stringify(archive));
}

/* ---- 受付の用紙（form.html）から届いたもの ----------------------------
   mayshare の submit.php が pending-records.json に積む。ここは読みに行くだけで、
   逆向きの呼び出しはしない。一件ずつ、まだ処理していない id だけを扱う。

     kind:'record'  新しい記録。番号を振り、盤に置き、wiki に記録票を起こす仕事を積む
     kind:'ps'      既存の記録への追伸。
                    受理済みの観測なら、その観測の追伸欄（post）に並べる（postscript.html が読む）。
                    観測に無い番号（小説の UMK0001〜0011、収蔵品など wiki にだけある記録）は、
                    wiki の記録票の末尾に足す仕事を積む。

   wiki に実際に書くのは、このすぐ後に走る ingest/fateofether.py（fateofether でログインして編集）。
   受付経由の言葉は本人確認ができないので、観測員番号には結びつけない（0000 として扱い、名だけ残す）。 */
const wdDone = new Set(await load('wikidot-done.json', []));
const wdJobs = await load('wikidot-jobs.json', []);
const PH_OK = new Set(Object.values(PH));
try{
  /* 検査用に、ファイルから読める口をひとつ開けてある（X_STUB と同じ考え方）。 */
  const pend = process.env.PENDING_STUB
    ? JSON.parse(await fs.readFile(process.env.PENDING_STUB, 'utf8'))
    : await fetch('https://mayshare.chu.jp/center/data/pending-records.json', { cache:'no-store' })
        .then(r => r.ok ? r.json() : []).catch(() => []);
  for(const p of (Array.isArray(pend) ? pend : [])){
    if(!p || !p.id || wdDone.has(p.id) || wdJobs.some(j => j.id === p.id)) continue;
    const seen = obs.some(o => o.src === 'form:' + p.id || (o.post || []).some(x => x.src === 'form:' + p.id));
    if(seen){ wdDone.add(p.id); continue; }
    const code = PH_OK.has(String(p.code || '').toUpperCase()) ? String(p.code).toUpperCase() : null;
    let coord = /^KYOTO\/[A-H][1-8](?:[a-h][1-8])*$/.test(p.coord || '') ? p.coord : null;
    let seed = null;
    /* 用紙は Google Maps の URL から緯度経度を送ってくる。盤の中なら区画、外なら地点符号にする */
    const lat = Number(p.lat), lng = Number(p.lng);
    if(!coord && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180){
      const cell = cellAt(lat, lng);
      if(cell) coord = 'KYOTO/' + cell; else seed = seedOf(lat, lng);
    }
    const f = { id:p.id, at:p.at || new Date().toISOString(), code, coord,
                title:p.title || '', obs:p.obs || '', then:p.then || '', now:p.now || '',
                name:p.name || '', pano:p.pano || '' };

    if(p.kind === 'ps'){
      const aid = String(p.target || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if(!/^(UMK|KYO|XXX)\d{4}$/.test(aid)){ console.log(`[受付] ${p.id} 追伸先が読めません（${p.target}）`); wdDone.add(p.id); continue; }
      const t = obs.find(o => o.aid === aid);
      if(t){
        t.post = t.post || [];
        t.post.push({ by:CFG.ANON, name:f.name || null, tx:f.obs, hint:code,
                      then:f.then || null, now:f.now || null,
                      at:f.at, src:'form:' + p.id, via:'form', permalink:null, img:null });
        postscripts.push({ aid, by:CFG.ANON, at:f.at });
        /* wiki にまだ記録票が無ければ起こし、あれば末尾に追伸を足す（保管室の「記録票をつくる」もここに来る） */
        const finder = (observers.profile || {})[t.by]?.name || `${t.by}号`;
        const rec = { aid, title: f.title || '', obs: t.first || t.tx || '', then: f.then || t.then || '', now: f.now || t.now || '',
                      code: code || t.hint || null, coord: t.coord || t.seed || null, pano: f.pano || '',
                      name: f.name, finder, img: t.img || null, at: t.at || f.at };
        wdJobs.push({ id:p.id, op:'ensure', fullname:`record:${aid.toLowerCase()}`,
                      title:aid, source:recordSource(rec), tags:recordTags(rec), block:postscriptBlock(f),
                      at:new Date().toISOString() });
        console.log(`[受付] ${p.id} → ${aid} の追伸欄に並べ、記録票を起こす／足す仕事を積みました。`);
      } else {
        wdJobs.push({ id:p.id, op:'append', fullname:`record:${aid.toLowerCase()}`, block:postscriptBlock(f),
                      at:new Date().toISOString() });
        console.log(`[受付] ${p.id} → record:${aid.toLowerCase()} の末尾に足す仕事を積みました。`);
      }
      continue;
    }

    /* 新しい記録 */
    const aid = issueAid(archive, coord || seed);
    const o = { id:'form:' + p.id, src:'form', by:CFG.ANON, name:f.name || null, state:'ok', kind:'form', yr:'',
                permalink:null, at:f.at, tx:f.obs, img:null, words:[], hint:code,
                then:f.then || null, now:f.now || null, coord, seed, handle:null,
                raw_text:f.obs, aid };
    obs.push(o); byId.set(o.id, o);
    const rec = { ...f, coord: coord || seed, aid };
    wdJobs.push({ id:p.id, op:'create', fullname:`record:${aid.toLowerCase()}`,
                  title:`${aid} ${f.title || ''}`.trim(), source:recordSource(rec), tags:recordTags(rec),
                  at:new Date().toISOString() });
    console.log(`[受付] ${p.id} → ${aid}（record:${aid.toLowerCase()} を起こす仕事を積みました）`);
  }
}catch(e){ console.error('[受付] 用紙の取得に失敗', e.message); }
/* 外部回線から、wiki にだけある記録へ届いた追伸 */
for(const w of wikiPs){
  if(wdDone.has(w.id) || wdJobs.some(j => j.id === w.id)) continue;
  wdJobs.push({ id:w.id, op:'append', fullname:`record:${w.aid.toLowerCase()}`,
                block:postscriptBlock({ ...w, obs:w.tx, via:'x', name:w.name || `${w.by}号` }),
                at:new Date().toISOString() });
  console.log(`[追伸] ${w.id} → record:${w.aid.toLowerCase()} の末尾に足す仕事を積みました。`);
}
await save('wikidot-jobs.json', wdJobs);
await save('wikidot-done.json', [...wdDone]);

await save('observations.json', obs);
await save('join-ack.json', acks);
await save('observers.json', observers);
await save('plates.json', plates);
await save('seeds.json', seeds);
await save('places.json', places);


await save('archive.json', archive);
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
  /* どの記録にも付けられなかった追伸。宛先を人が直すまで、ここで待つ */
  unresolved,
  drifting: drifting.map(o=>({
    id:o.id, by:o.by, src:o.src||null, state:o.state, img:o.img, permalink:o.permalink, at:o.at, tx:o.tx,
    words:(o.words||[]).map(w=>({ by:w.by, state:w.state, tx:w.tx })),
    aid:o.aid || null, hint:o.hint || null, then:o.then || null, now:o.now || null,
  })),
  /* 盤の外の観測も載せる。スラッシュがあれば区画、無ければ地点符号。
     載らないということは、投稿しても何も起きないということ。そこを塞ぐ。 */
  records: obs.filter(o=>o.coord || o.seed).map(o=>({
    aid:o.aid || null, hint:o.hint || null,
    then:o.then || null, now:o.now || null, name:o.name || null,
    post:(o.post || []).map(x=>({ by:x.by, tx:x.tx, hint:x.hint || null,
                                  then:x.then || null, now:x.now || null, name:x.name || null,
                                  at:x.at, via:x.via || null, src:x.src || null,
                                  permalink:x.permalink || null, img:x.img || null })),
    coord:o.coord || o.seed, yr:o.yr||'', by:o.by, src:o.src||null, kind:o.kind||'photo', state:o.state,
    img:o.img, permalink:o.permalink, tx:o.tx, locatedBy:o.locatedBy || null,
    words:(o.words||[]).map(w=>({ by:w.by, state:w.state, tx:w.tx })),
  })),
});

console.log(`[観測] 新規 ${fresh.length} ／ 言葉 ${words.length} ／ 総数 ${obs.length}`
          + ` ／ 定位 ${located.length} ／ 未定位 ${drifting.length}`
          + ` ／ 追伸 ${postscripts.length} ／ 宛先不明 ${unresolved.length}`
          + ` ／ 割れたセル ${opened.length} ／ 生まれた盤 ${born.length}`
          + ` ／ 無記名 ${obs.filter(o=>o.by===CFG.ANON).length}`
          + ` ／ 本日の返信 ${state.replies[day]}`
          + ` ／ 認証 ${hasOAuth1() ? 'OAuth1.0a' : (canWrite() ? 'OAuth2' : 'なし')}`);

if(pending.length){
  console.log(`[要対応] 名の無い盤が ${pending.length} 件あります。`
            + ` boards-pending.json に name を書いて boards.json へ移してください。`
            + ` 名が付くまで、その盤の観測に座標は配られません。`);
}
