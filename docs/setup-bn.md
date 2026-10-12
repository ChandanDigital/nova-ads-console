# সেটআপ গাইড (বাংলা) — শুধু ব্রাউজার দিয়ে, বিনামূল্যে

এই গাইডে আপনার কম্পিউটারে Python, Node.js, Docker বা কমান্ড-লাইন **কিছুই ইনস্টল করতে হবে না**। সব কাজ GitHub, Cloudflare ও Google-এর ওয়েবসাইটে করা হবে।

> **গুরুত্বপূর্ণ সততা-নোট:** এই সফটওয়্যার স্বয়ংক্রিয় টেস্টে পাস করেছে, কিন্তু **এখনও কোনো আসল Google Ads অ্যাকাউন্ট বা আসল Cloudflare ডিপ্লয়মেন্টে পরীক্ষা করা হয়নি।** তাই প্রথমে একটি **টেস্ট অ্যাকাউন্ট** দিয়ে শুরু করুন। ওয়েবসাইটের বোতামের নাম কখনও সামান্য আলাদা হতে পারে; কাছাকাছি নামের বোতামটি খুঁজুন।

> **খরচ:** হোস্টিং খরচ শূন্য টাকা (Cloudflare ও GitHub-এর ফ্রি প্ল্যান)। এই প্রোগ্রাম কখনও নিজে থেকে পেইড প্ল্যানে যায় না। তবে **Google Ads-এ বিজ্ঞাপনের খরচ** এবং **AI অ্যাপের সাবস্ক্রিপশন** (যেমন Claude) আলাদা খরচ — এগুলো এই সিস্টেমের বাইরে।

## আপনার যা লাগবে

1. একটি **GitHub** অ্যাকাউন্ট (বিনামূল্যে)
2. একটি **Cloudflare** অ্যাকাউন্ট (বিনামূল্যে)
3. একটি **Google** অ্যাকাউন্ট, যেটি Google Ads অ্যাকাউন্টে অ্যাক্সেস পায় (আপনার ক্ষেত্রে অ্যাকাউন্ট `3010086756`)
4. এই ZIP ফাইল: `nova-ads-console-cloud-0.3.0.zip`

---

## ধাপ ১ — GitHub-এ প্রাইভেট রিপোজিটরি বানান

1. GitHub-এ গিয়ে **New repository** চাপুন।
2. নাম দিন `nodi-ads-cloud`। **Private** বেছে নিন। "Add a README" টিক দেবেন না। **Create repository** চাপুন।
3. কম্পিউটারে ZIP ফাইলটি **Extract (আনজিপ)** করুন।
4. নতুন রিপোজিটরির পাতায় **uploading an existing file** লিঙ্কে চাপুন।
5. আনজিপ করা ফোল্ডারের **ভেতরের ফাইল ও ফোল্ডারগুলো** (ফোল্ডারটি নিজে নয়) টেনে এনে ছাড়ুন। GitHub একবারে প্রায় ১০০টি ফাইল নেয়, তাই **২–৩ ধাপে** দিন:
   - প্রথমে: `src`, `public`, `migrations`, `scripts`, `github-only` ফোল্ডার ও বাইরের ফাইলগুলো (`package.json`, `wrangler.jsonc` ইত্যাদি)
   - তারপর: `test` ও `docs`
   - শেষে: `.github` (এটি লুকানো ফোল্ডার — Windows Explorer-এ *View → Show → Hidden items* চালু করুন)
   প্রতিবার নিচে **Commit changes** চাপুন (branch: `main`)।
6. রিপোজিটরিতে `.github/CODEOWNERS` ফাইল খুলে পেন্সিল আইকন চাপুন এবং `@REPLACE-WITH-YOUR-GITHUB-USERNAME` জায়গায় আপনার GitHub ইউজারনেম লিখুন।

> কেন GitHub Pages নয়? ফ্রি প্ল্যানে GitHub Pages শুধু **পাবলিক** রিপোজিটরিতে চলে। অ্যাকাউন্টের তথ্য দেখানো ড্যাশবোর্ড পাবলিক হওয়া উচিত নয়। তাই ড্যাশবোর্ডটি Cloudflare Worker নিজেই সাইন-ইনের পেছনে পরিবেশন করে।

## ধাপ ২ — Cloudflare-এ প্রকল্প তৈরি (GitHub থেকে)

1. Cloudflare ড্যাশবোর্ড → **Workers & Pages** → **Create** → **Import a repository** (Workers Builds)।
2. GitHub অ্যাকাউন্ট যুক্ত করুন; Cloudflare GitHub অ্যাপকে **শুধু `nodi-ads-cloud` রিপোজিটরির** অনুমতি দিন।
3. রিপোজিটরি বেছে নিন। **Project name** অবশ্যই লিখুন: **`nodi-ads-cloudflare`** (এর সঙ্গে `wrangler.jsonc`-এর নাম হুবহু মিলতে হবে)। Build command ফাঁকা রাখুন; Deploy command যেমন আছে তেমনই থাকুক (`npx wrangler deploy`)। **Save and Deploy** চাপুন।
4. সফল হলে আপনার ঠিকানা হবে `https://nodi-ads.<আপনার-সাবডোমেইন>.workers.dev`। ব্রাউজারে `…/healthz` খুললে `{"ok":true,…}` দেখা উচিত।

**যদি বিল্ড D1 ডাটাবেস নিয়ে ভুল দেখায়:** Cloudflare → **Storage & databases → D1 → Create database** → নাম `nodi-ads-db` → তৈরির পর **Database ID** কপি করুন। GitHub-এ `wrangler.jsonc` খুলে পেন্সিল চাপুন এবং `d1_databases` অংশে `"database_id": "<কপি করা আইডি>"` যোগ করে Commit করুন। এরপর নিজে থেকেই আবার ডিপ্লয় হবে।

ডাটাবেসের টেবিলগুলো প্রথমবার চালু হলে নিজে থেকেই তৈরি হয় (কোনো কিছু মুছে না, ধ্বংসাত্মক নয়)। আপনাকে আলাদা কিছু চালাতে হবে না।

## ধাপ ৩ — গোপন মান (Secrets) যোগ করুন

1. ব্রাউজারে `https://nodi-ads.<…>.workers.dev/generate-secrets.html` খুলুন। এই পাতা দুটি র‍্যান্ডম মান **আপনার ব্রাউজারের ভেতরেই** বানায়; কিছুই কোথাও পাঠানো বা সংরক্ষণ হয় না।
2. Cloudflare → আপনার Worker (`nodi-ads-cloudflare`) → **Settings → Variables and Secrets → Add**। ধরন (Type) বেছে নিন **Secret**। চারটি যোগ করুন:

| নাম | মান |
|---|---|
| `TOKEN_ENCRYPTION_KEY` | জেনারেটর পাতা থেকে (পাসওয়ার্ড ম্যানেজারে একটি কপি রাখুন) |
| `ADMIN_SETUP_SECRET` | জেনারেটর পাতা থেকে (শুধু আপনি জানবেন) |
| `GOOGLE_CLIENT_ID` | ধাপ ৪ থেকে |
| `GOOGLE_CLIENT_SECRET` | ধাপ ৪ থেকে |

এই মানগুলো GitHub-এ বা পাতার কোডে কখনও থাকে না।

## ধাপ ৪ — Google Cloud-এ OAuth ক্লায়েন্ট বানান

1. [console.cloud.google.com](https://console.cloud.google.com) → নতুন **Project** তৈরি করুন (যেকোনো নাম)।
2. **APIs & Services → Library** → **Google Ads API** খুঁজে **Enable** করুন।
3. **OAuth consent screen** (Google Auth platform): User type **External**। Scope হিসেবে `https://www.googleapis.com/auth/adwords` যোগ করুন। তারপর অ্যাপটি **Publish (In production)** করুন। সাইন-ইনের সময় Google "unverified app" সতর্কতা দেখাবে — **Advanced → Continue** চাপুন। **অ্যাপ "Testing" মোডে রাখবেন না:** Testing মোডে রিফ্রেশ টোকেন **৭ দিনে** শেষ হয়ে যায়।
4. **Credentials → Create credentials → OAuth client ID → Web application**। **Authorized redirect URIs**-এ হুবহু এই ঠিকানা দিন: `https://nodi-ads.<…>.workers.dev/oauth/google/callback` (ড্যাশবোর্ডের *Google connection* পাতায় ঠিক এই ঠিকানা দেখানো থাকে — এক অক্ষরও আলাদা হলে চলবে না)।
5. তৈরি হলে **Client ID** ও **Client secret** কপি করে ধাপ ৩-এর Cloudflare Secrets-এ বসান।

**Developer Token আর লাগে না** (৯ সেপ্টেম্বর ২০২৬ থেকে বন্ধ)। আপনি কতটা অ্যাক্সেস পাবেন তা নির্ভর করে আপনার Cloud প্রজেক্টের Google Ads API **অ্যাক্সেস লেভেলের** ওপর: *Test access* শুধু Google Ads **টেস্ট অ্যাকাউন্টে** কাজ করে; আসল অ্যাকাউন্টের জন্য Basic/Standard access লাগে। ড্যাশবোর্ড `production_access_restricted` দেখালে [Google-এর এই পাতা](https://developers.google.com/google-ads/api/docs/api-policy/developer-token) দেখে অ্যাক্সেসের আবেদন করুন।

## ধাপ ৫ — প্রথমবার সাইন-ইন

1. Worker-এর ঠিকানা খুলুন। `ADMIN_SETUP_SECRET`-এর মানটি দিন।
2. পর্দায় আপনার **অ্যাডমিন ক্রেডেনশিয়াল** (`nodi_admin_…`) **একবারই** দেখানো হবে। এখনই পাসওয়ার্ড ম্যানেজারে সংরক্ষণ করুন। **কখনও AI চ্যাটে পেস্ট করবেন না।** "I have saved it" টিক দিয়ে Continue চাপুন।
3. বাম মেনুতে **Google connection → Connect Google Ads** চাপুন। যে Google ইউজার Ads অ্যাকাউন্টে অ্যাক্সেস পান তা দিয়ে সাইন-ইন করুন। তারপর **Discover accounts** চাপুন।
4. **Accounts** পাতায় শুধু সেই অ্যাকাউন্টগুলো **চালু (on)** করুন যা AI ব্যবহার করতে পারবে (যেমন `3010086756`)। ডিফল্টভাবে AI কিছুই দেখে না।
5. **Diagnostics** পাতায় সব সবুজ কিনা দেখুন।

## ধাপ ৬ — AI অ্যাপ যুক্ত করুন

- **Claude (ওয়েব/ডেস্কটপ):** Settings → **Connectors** → **Add custom connector** → URL দিন: `https://nodi-ads.<…>.workers.dev/mcp`। Claude নিজেকে রেজিস্টার করবে; ড্যাশবোর্ডে সাইন-ইন থাকলে আপনি একটি অনুমতি-পাতা দেখবেন — **Allow** চাপুন। (Claude Desktop-এর কনফিগ ফাইলে রিমোট সার্ভার চলে না; Connectors ব্যবহার করুন।)
- **Claude Code:** `claude mcp add --transport http nodi-ads https://nodi-ads.<…>.workers.dev/mcp` — অথবা ড্যাশবোর্ডের **AI access** পাতায় টোকেন বানিয়ে `--header "Authorization: Bearer <টোকেন>"` ব্যবহার করুন।

শুরুতে শুধু `read` ও `draft` অনুমতি দিন। `apply` তখনই দিন, যখন চান AI আপনার **অনুমোদিত** পরিকল্পনা চালাক। কোনো AI অনুমতি দিয়েই পরিকল্পনা **অনুমোদন** করা যায় না।

## ধাপ ৭ — প্রথম নিরাপদ পরিবর্তন

1. AI-কে বলুন: "ক্যাম্পেইন X-এর দৈনিক বাজেট ৩০০ করার একটি খসড়া পরিকল্পনা বানাও এবং ব্যাখ্যা করো।"
2. ড্যাশবোর্ডে **Approvals** খুলুন। আগের মান, নতুন মান, খরচের প্রভাব ও পুনরুদ্ধারের সীমা পড়ুন। অনুমতির ধরনগুলো টিক দিন, `APPROVE` লিখুন, বোতাম চাপুন।
3. AI-কে বলুন পরিকল্পনাটি চালাতে। এটি ঠিক যা অনুমোদিত তা-ই একবার চলবে। **Activity** পাতায় ফলাফল দেখুন।

## ক্রেডেনশিয়াল হারিয়ে গেলে

অ্যাডমিন ক্রেডেনশিয়াল কখনও উদ্ধার বা "ক্র্যাক" করা যায় না — শুধু **বদলানো** যায়, এবং কেবল **Cloudflare অ্যাকাউন্টের মালিক** তা করতে পারেন:

1. Worker-এর `/generate-secrets.html` পাতা থেকে নতুন একটি মান নিন।
2. Cloudflare → Worker → Settings → Variables and Secrets-এ `ADMIN_SETUP_SECRET`-এর মান **নতুন মানে বদলান**। (প্রতিটি মান একবারই কাজ করে।)
3. লগইন পাতায় **Lost your credential?** চাপুন। নতুন মানটি দিন, `REPLACE CREDENTIAL` লিখুন। পুরনো ক্রেডেনশিয়াল ও সব সেশন বন্ধ হবে; নতুনটি একবারই দেখানো হবে।
4. অনুমোদনের রেকর্ড, ইতিহাস ও Google সংযোগ অক্ষত থাকে। (ডিফল্টে সব AI টোকেন বাতিল হয়; আবার বানিয়ে নিন।)

## প্রতিদিনের নিরাপত্তা-সুইচ

- **Overview → Global stop:** সঙ্গে সঙ্গে সব অ্যাকাউন্ট-পরিবর্তন আটকে দেয়।
- **AI access → Revoke every AI token:** সব AI অ্যাপের অ্যাক্সেস কেটে দেয়।
- **Credential security → Daily budget cap:** এর চেয়ে বেশি দৈনিক বাজেটের পরিকল্পনা আর বানানো যায় না।

## সমস্যা হলে

| লক্ষণ | কারণ / সমাধান |
|---|---|
| বিল্ড Worker-এর নাম নিয়ে ভুল দেখায় | Cloudflare-এ নাম অবশ্যই `nodi-ads-cloudflare` |
| বিল্ড D1 নিয়ে ভুল দেখায় | ধাপ ২-এর D1 অংশ দেখুন (`database_id` দিন) |
| `redirect_uri_mismatch` | Google Cloud-এর URI ও ড্যাশবোর্ডে দেখানো URI এক অক্ষরও আলাদা |
| প্রায় এক সপ্তাহ পর `credentials_expired` | অ্যাপ এখনও Testing মোডে; Production-এ প্রকাশ করে আবার Connect করুন |
| `production_access_restricted` | আপনার Cloud প্রজেক্টে শুধু Test access আছে |
| `quota_soft_limit` | প্রোগ্রাম নিজেই দৈনিক সীমায় থেমেছে (পেইড-এ যায়নি); *Hosting & quotas* দেখুন, UTC মধ্যরাতে রিসেট |
| "Worker exceeded CPU" | ছোট তারিখ-পরিসর বেছে নিন (ফ্রি প্ল্যানে প্রতি অনুরোধে ১০ ms CPU) |

## পুরনো লোকাল (Python) সংস্করণের ডেটা

পুরনো `~/.nodi-ads` ফোল্ডারে **কিছু পরিবর্তন, সরানো বা মোছা হয় না।** চাইলে `docs/migration.md` দেখুন: একটি শুধু-পড়া এক্সপোর্ট টুল অনুমতির তালিকা, পরিকল্পনা ও ইতিহাস ক্লাউডে **আর্কাইভ** হিসেবে আনে। Google রিফ্রেশ টোকেন, ক্লায়েন্ট সিক্রেট ও এনক্রিপশন কী **কখনও** আনা হয় না; ক্লাউডে Google একবার নতুন করে যুক্ত করতে হয় (১ মিনিটের কাজ)।
