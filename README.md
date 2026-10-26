# untappd-rebalance

Download your whole Untappd history, decide what its rating distribution *should* look like,
apply that mapping to the account, and undo it if you change your mind.

Four ideas, in order:

1. **fetch** — pull every check-in (rating, comment, venue, beer, brewery) from the website
   into `data/checkins.jsonl`.
2. **propose** — compute a rating → rating mapping for a target median and a chosen shape,
   print it, and save it as `data/plan.json`. Nothing is sent anywhere.
3. **apply** — write the mapping to the account through the app's own API, one check-in at
   a time, recording each write in `data/applied.jsonl`.
4. **reverse** — replay that ledger backwards to put every rating back.

## Read this first

The write path is **not** the public Untappd API. It is the API the Android app talks to,
reached with the app's own OAuth client, and Untappd does not document it or license it for
third parties. In 2026 they stopped issuing API access altogether:

> Due to API abuse, we are no longer making API access available without a commercial
> agreement. […] existing API tokens may no longer continue to work.

Their co-founder, on the edit route this tool uses:

> Mainly this is a private function of the untappd app — so it's not available via the third
> party api.

So: use it on **your own account**, keep the writes few, and expect it to stop working
without notice. Do not point it at anyone else's account. Do not run it as a service. If a
bulk rewrite is what you want, understand first that Untappd has no undo of its own — the
ledger described below is the only one, and it only exists because you kept it.

The read path (`fetch`) is ordinary web scraping of pages your own browser session can see.
Nothing there is privileged, and it works without any of the above.

## Requirements

- Node.js 22+ (built-in `fetch` and `WebSocket`; no dependencies, no `npm install`)
- Chrome, signed in to untappd.com — for `login` only, one debugging prompt
- `unzip` — for the `apk` command only

## Quickstart

```sh
# 1. one Chrome prompt, then Chrome can be closed
node scripts/rebalance.mjs login

# 2. download the history
node scripts/rebalance.mjs fetch --user YOURNAME

# 3. see what a rebalance would look like; writes data/plan.json
node scripts/rebalance.mjs propose --target 2.5 --strategy quantile

# 4. look at it, then apply it (no --yes means dry run)
node scripts/rebalance.mjs apply
node scripts/rebalance.mjs apply --yes

# 5. or put everything back
node scripts/rebalance.mjs reverse --yes
```

`apply` refuses to run if `data/checkins.jsonl` changed since `propose` (it records the
file's SHA-256), because a plan computed from a different snapshot has the wrong targets.

## Choosing a distribution

Three shapes, and the choice is a real trade-off rather than taste. The grid is the first
constraint: **Untappd stores quarter points only** (0.25 … 5), so there are 20 usable
slots, and a typical history already uses 19 of them.

| strategy | what it does | keeps | costs |
|---|---|---|---|
| `shift` | subtracts one constant so the median lands on the target | every gap, exactly; the shape is translated | the top gets clipped: with a 1.5 shift, a 5.0 beer reads 3.5 and "perfect" stops existing |
| `quantile` | maps by percentile, pinned at median→target and best→5 | the top of the scale, and the crowded middle finally spans the scale | rare levels merge; on a real history 19 levels became 9 |
| `compress` | linear from the minimum to the median | the bottom stays ordered and distinct, nothing is clipped | the range shrinks instead of spreading |

The arithmetic that decides it: if 15 of your 19 rating levels sit below the median, keeping
them distinct at 0.25 spacing needs 3.5 points below the median, and only 2.5 exist. So
**pinning the median forces merges**, and the only question is where they land. `quantile`
spends them at the bottom, where few beers live; `shift` and `compress` spend them at the
top.

`quantile` is the default because "my average beer should read average" is usually the goal,
and it is the only strategy that spreads a cluster.

## How `apply` avoids wrecking things

- **A ledger, not hope.** `data/applied.jsonl` gets one line per check-in with the value
  before and after. Resume = skip anything whose last line says success. Undo = the same
  loop with `reverse`.
- **A plan fingerprint.** `data/plan.json` carries the SHA-256 of the archive it was computed
  from; a mismatch aborts before any write.
- **Pacing.** 1.2 s between writes by default. A `429` is waited out with backoff rather than
  retried blindly.
- **Early stop.** `401`/`403` aborts at once (a stale token is not a per-check-in rejection),
  and `--max-failures` consecutive failures stop the run before the account looks like it is
  under attack.
- **Idempotence.** Check-ins whose target equals their current rating are skipped, so a
  resumed run does not rewrite work it already did.
- **Git, optionally.** With `--batch 50` the ledger is committed and pushed every 50 writes,
  so an interruption costs at most that many. Use `--batch 0` to keep it local.

`data/` is meant to be committed: the plan and the ledger *are* the history of what you did
to your account. Secrets are not — see below.

## Reading the app's credentials out of the APK

The app is **Cordova/Ionic**, which is the whole reason this is easy: the network layer is
plain JavaScript in the package, so there is no binary to reverse, no emulator, no root, no
certificate pinning to defeat, and no TLS interception. You read a text file.

```sh
node scripts/rebalance.mjs apk untappd.apk
```

That unzips `assets/www/*`, finds the bundle that assigns a client per platform, and prints
the iOS/Android pairs plus the app version. If you want to do it by hand:

```sh
unzip -o untappd.apk 'assets/www/*' -d /tmp/apk
rg -o 'clientId="[0-9a-f]{32}"|clientSecret="[0-9a-f]{32}"|appVersion="[0-9.]+"' /tmp/apk/assets/www/build/*.js
```

The values appear in a ternary chain, one client per platform:

```js
this.baseUrl = "https://api.untappd.com/v4", this.appVersion = "3.5.3",
this.clientId = "…ios…", this.clientSecret = "…"
  : platform.is("android") ? (this.clientId = "…android…", this.clientSecret = "…")
```

Take the **android** pair. Write it, 0600, outside the repository:

```sh
mkdir -p ~/.config/untappd-rebalance && chmod 700 ~/.config/untappd-rebalance
$EDITOR ~/.config/untappd-rebalance/app-client.json   # {"client_id":"…","client_secret":"…","app_version":"3.5.3"}
```

Or set `UNTAPPD_CLIENT_ID` / `UNTAPPD_CLIENT_SECRET` / `UNTAPPD_APP_VERSION`.

### Getting an APK

APKPure and APKMirror are behind Cloudflare and will answer `403` to a script. Aptoide's API
is not:

```sh
curl -s "https://ws75.aptoide.com/api/7/app/get/package_name=com.untappdllc.app" \
  | jq '.nodes.meta.data.file | {path, md5sum, filesize}'
curl -o untappd.apk "<path from above>"; md5sum untappd.apk   # match md5sum before trusting it
```

An emulator is not needed on Linux, and iOS is not possible at all — the simulator needs
macOS and Xcode. Note that a sideloaded APK is of unverifiable provenance: it is somebody
else's build of the app, which is a reason to check that MD5 and to keep the app's
credentials out of anything you publish.

## Calling the API by hand

Two mechanisms, and they are not interchangeable:

```
website   Cookie session cookie                    → GET pages (fetch)
app API   client_id + client_secret + access_token → POST (apply)
```

Every call is a form-encoded POST with the client credentials in the query string:

```
?client_id=…&client_secret=…&utv=3.5.3[&access_token=…]
```

`utv` is the app version, sent by the app on every request.

### 1. Trade a password for a token

```sh
curl -s -X POST "https://api.untappd.com/v4/xauth?client_id=$CID&client_secret=$CSE" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'user_name=YOURNAME' \
  --data-urlencode 'user_password=…' \
  --data 'app_verison=3.5.3&existing_device=old&device_name=sdk&device_udid=7f3c1a9e52bd4c81&device_version=14&device_platform=Android'
```

`app_verison` is misspelled **in the app**, and has to be sent that way. The reply carries a
40-character `access_token`; the tool stores it in `~/.config/untappd-rebalance/token.json`,
never the password.

### 2. Change one rating

```sh
curl -s -X POST "https://api.untappd.com/v4/beer/rate/$BEER_ID?client_id=$CID&client_secret=$CSE&utv=3.5.3&access_token=$TOK" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "checkin_id_rate=$CHECKIN_ID" --data-urlencode 'rating_score=3.5'
```

```json
{"response":{"result":"success","rating_method":"update","old_score":4.25,"new_score":3.5}}
```

`checkin_id_rate` is what makes this an edit rather than a fresh rating: the check-in keeps
its id, its timestamp, its photo, its toasts and its comments. `rating_method: "update"` in
the reply is how you know it was an edit.

The app's edit screen uses a different call — `POST /v4/checkin/edit/{checkin_id}` with the
*entire* check-in form. Don't: a partial form blanks fields such as the comment or venue.

### 3. What ratings are actually accepted

Quarter points, and the server's own error message is out of date. It says
`Valid ratings are: 1, 1.5, 2.0, 2.5, 3, 3.5, 4.0, 4.5, 5.` — but measured on a real
account, `4.25` and `0.75` are accepted and `4.3` / `4.4` are rejected. So: multiples of
0.25, from 0.25 up (0 means "no rating"). `snap()` in the script assumes exactly that.

### 4. Finding routes that are not documented

The API answers `404` for a route that does not exist, and `500`
`{"error_detal":"Your missing the 'client_secret' and/or 'client_id' parameter"}` for one
that does. That difference is a free map of the private surface: POST without credentials
and read the status. It is how `/beer/rate/{bid}` and `/checkin/edit/{id}` were found, and
how `/checkin/update/{id}` was ruled out.

Careful: the website has a catch-all, so the same trick does **not** work on
`untappd.com/apireqs/*`.

## A note on stale reads

Untappd's read path lags its writes by one to two minutes: `checkin/view` and the check-in
page will keep serving the old rating while the write has already landed. Longer than that,
the feed fragments used by `fetch` can be cached per cursor, so a refetch may come back with
pre-rewrite content — this happened four times while a 1,230-rating migration propagated,
and each time the sync "succeeded" while writing unchanged data.

The defence is in the tool: `apply` records every write, and a re-run of `fetch` plus
`propose` can be checked against that ledger. If the archive disagrees with the ledger, the
read was stale; wait and refetch rather than trusting the file.

## Troubleshooting

| symptom | cause |
|---|---|
| `403` from APKPure/APKMirror | Cloudflare; use Aptoide's API, or a browser |
| `no client credentials found` | not a Cordova build, or a `.xapk` — extract it first |
| `401` on every write | token expired: delete `token.json` and re-run (it will ask for the password) |
| `429` and long pauses | rate limited; the tool backs off 30 s, 60 s, 90 s on the same write |
| rating "did not change" | reads lag writes 1–2 min; check `checkin/view` later, or the ledger |
| `the plan was computed from a different checkins.jsonl` | re-run `propose` after `fetch` |
| `nothing to commit` from git in a sync tool | a `git reset --hard` after writing silently reverts the data — reset *before*, never after |
| a script that "does nothing" when symlinked | `import.meta.url` is resolved, `process.argv[1]` is not: compare realpaths |

The last two are recorded because they cost hours: both fail silently, and both made a
working tool look like a broken API.

## What is in `data/`

| file | what |
|---|---|
| `checkins.jsonl` | the downloaded archive, one JSON object per line, oldest first |
| `plan.json` | the mapping and the statistics it was derived from, with the source SHA-256 |
| `applied.jsonl` | the ledger: `{checkin_id, beer, from, to, result, status, at}` |

Commit all three. Do not commit `cookies.json`, `token.json`, `app-client.json` or any APK —
they are outside the repository by default, and `.gitignore` covers the rest.

## Licence

MIT for this repository's code. The Untappd name, app, API and its embedded credentials are
Untappd's, not mine to license — see "Read this first".
