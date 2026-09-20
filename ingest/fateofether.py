"""fateofether.py — 受付の用紙から届いたものを wiki に書く（API 鍵を使わない版）

Wikidot の API 鍵は、無料アカウントだと発行の申請と承認待ちが要る。
そこで API（XML-RPC）ではなく、ふつうの画面と同じ経路（ログインして編集）で書く。
使うのは wikidot.py（pip install wikidot）。SCP-JP などの bot でも使われている定番のライブラリ。

observe.mjs が data/wikidot-jobs.json に積んだ仕事を、一件ずつ片づける。
  op:'create'  record:xxx を新しく起こす。すでに頁があれば上書きしない（人が起こした記録を守る）
  op:'append'  既存の record:xxx の rec-foot の手前に、追伸の一片を足す
  op:'ensure'  record:xxx が無ければ起こし（source）、あれば追伸の一片を足す（block）

カルマのないアカウントは、Wikidot が保存のたびに CAPTCHA を出す（need_captcha）。
その時は仕事を減らさずに置いたまま、写せる形で覚書（Actions の Summary）に出す。
カルマが付けば、同じ仕事がそのまま次の現像で通る。

必要な secrets
  WIKIDOT_USER      fateofether
  WIKIDOT_PASSWORD  fateofether のパスワード
どちらかが無ければ何もしない。DRY_RUN=1 のときは書かずにログだけ出す。
"""
import json, os, sys, time
from pathlib import Path

DATA = Path('data')
SITE = os.environ.get('WIKIDOT_SITE', 'alembic')
USER = os.environ.get('WIKIDOT_USER', '')
PASS = os.environ.get('WIKIDOT_PASSWORD', '')
DRY = os.environ.get('DRY_RUN') in ('1', 'true')
SUMMARY = os.environ.get('GITHUB_STEP_SUMMARY')
MAX_TRIES = 3


def load(name, default):
    try:
        return json.loads((DATA / name).read_text(encoding='utf-8'))
    except Exception:
        return default


def save(name, value):
    (DATA / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def note(text):
    """Actions の Summary に書く。人が読んで、そのまま wiki に写せるように。"""
    if not SUMMARY:
        return
    with open(SUMMARY, 'a', encoding='utf-8') as f:
        f.write(text + '\n')


jobs = load('wikidot-jobs.json', [])
if not jobs:
    print('[fateofether] 仕事はありません。')
    sys.exit(0)
if not USER or not PASS:
    print(f'[fateofether] WIKIDOT_USER / WIKIDOT_PASSWORD が無いので書きません（待ち {len(jobs)} 件）。')
    sys.exit(0)
if DRY:
    for j in jobs:
        print(f"[fateofether DRY] {j.get('op')} {j.get('fullname')}")
    sys.exit(0)

import wikidot  # noqa: E402

client = wikidot.Client(username=USER, password=PASS)
site = client.site.get(SITE)


def do_create(j):
    if site.page.get(j['fullname'], raise_when_not_found=False):
        print(f"[fateofether] {j['fullname']} はすでにあります。上書きしません。")
        return
    page = site.page.create(fullname=j['fullname'], title=j.get('title', ''),
                            source=j['source'], comment='受付の用紙から')
    tags = j.get('tags') or []
    if tags:
        page = site.page.get(j['fullname'])
        page.tags = tags
        page.commit_tags()
    print(f"[fateofether] {j['fullname']} を起こしました。")


def do_append(j):
    page = site.page.get(j['fullname'], raise_when_not_found=False)
    if not page:
        raise RuntimeError('頁が見つかりません')
    src = page.source.wiki_text
    mark = f"[!-- 追伸 {j['id']} --]"
    if mark in src:
        return
    foot = src.rfind('[[div class="rec-foot"]]')
    block = j['block'].strip()
    nxt = src[:foot] + block + '\n\n' + src[foot:] if foot >= 0 else src.rstrip() + '\n\n' + block + '\n'
    page.edit(source=nxt, comment='受付の用紙から追伸')
    # 読み直して、足したものが残っているかを確かめる（人の編集と重なったら次の回にもう一度）
    again = site.page.get(j['fullname'])
    if mark not in again.source.wiki_text:
        raise RuntimeError('追伸が残っていません（編集が重なった可能性）')
    print(f"[fateofether] {j['fullname']} に追伸を足しました。")


done = load('wikidot-done.json', [])
failed = load('wikidot-failed.json', [])
left = []
held = []          # CAPTCHA で置いたままのもの
def do_ensure(j):
    if site.page.get(j['fullname'], raise_when_not_found=False):
        do_append(j)
    else:
        do_create(j)


for j in jobs:
    try:
        {'append': do_append, 'ensure': do_ensure}.get(j.get('op'), do_create)(j)
        done.append(j['id'])
    except Exception as e:  # 一件の失敗で全体を止めない
        msg = str(e)[:200]
        if 'need_captcha' in msg:
            # 手が足りないのではなく、鍵が下りていないだけ。数を数えずに置いておく。
            j['held'] = 'need_captcha'
            held.append(j)
            left.append(j)
            print(f"[fateofether] {j.get('fullname')} は CAPTCHA で保留（カルマ待ち）。")
        else:
            j['tries'] = j.get('tries', 0) + 1
            j['error'] = msg
            print(f"[fateofether] {j.get('op')} {j.get('fullname')} 失敗（{j['tries']} 回目）: {msg}")
            (failed if j['tries'] >= MAX_TRIES else left).append(j)
    time.sleep(2)  # 人の編集と同じくらいの間隔で

if held:
    note(f'## 受付から届いた、まだ書けていない {len(held)} 件\n')
    note('この帳面のアカウントには、まだ Wikidot の鍵（カルマ）が下りていません。')
    note('下の本文をそのまま wiki に写せば、同じ記録票になります。'
         'カルマが付けば、次の現像から自動で並びます。\n')
    for j in held:
        note(f"### {j.get('fullname')}　{j.get('title') or ''}")
        tags = ' '.join(j.get('tags') or [])
        if tags:
            note(f'タグ： `{tags}`\n')
        body = j.get('source') or j.get('block') or ''
        note('```\n' + body.strip() + '\n```\n')

save('wikidot-jobs.json', left)
save('wikidot-done.json', done)
save('wikidot-failed.json', failed)
print(f"[fateofether] 残り {len(left)}（うち保留 {len(held)}） ／ 止めた {len(failed)}")
