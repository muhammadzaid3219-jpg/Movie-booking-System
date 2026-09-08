# Movie Ticket Booking System

A complete, production-style cinema booking platform: customer site, admin panel and REST API.

**Stack:** Node.js + Express with plain HTML/CSS/JavaScript on the front end, and a choice of
**SQLite** (default, zero setup) or **Cloud Firestore** — one line in `.env` switches between them,
and both are at full feature parity.
No front-end framework, no CSS framework, and no chart or QR library: everything is written here.

---

## Running it

```bash
npm install
npm start
```

Then open **http://localhost:3000**

| Role  | Email               | Password |
|-------|---------------------|----------|
| Admin | admin@cinema.com    | admin123 |
| User  | ali@example.com     | user123  |
| User  | sara@example.com    | user123  |
| User  | bilal@example.com   | user123  |

### Configuration

Copy `.env.example` to `.env` and edit it. Nothing secret is hardcoded — secrets, fees, hold
times, currency and the payment provider all come from the environment (`src/config.js`).
In production the server **refuses to start** unless `APP_SECRET` is set.

### Choosing the database

`DB_DRIVER` in `.env` picks one of three, and **all three pass the same 77-test suite**:

| Driver | What it is | Setup |
|---|---|---|
| `sqlite` | Local file | None at all |
| `rtdb` | Firebase **Realtime Database** | Service-account key |
| `firestore` | **Cloud Firestore** | Service-account key |

```
DB_DRIVER=rtdb        # in .env
```

The startup banner prints which one is active. SQLite has its own routes in
`src/routes/sqlite/`; the two Firebase databases **share** `src/routes/cloud/`, because
`src/fstore.js` (Firestore) and `src/rtdbstore.js` (Realtime Database) expose an identical set of
functions behind `src/store.js`. The front end never changes for any of them.

### Where accounts live

`AUTH_PROVIDER` in `.env` chooses between two, and both use the same login pages:

| Value | Passwords stored | Users visible in |
|---|---|---|
| `local` | scrypt hashes in this app's own database | the admin panel only |
| `firebase` | Firebase Authentication | the Firebase console's **Authentication** tab, and the admin panel |

With `firebase`, signing up creates a real Firebase Auth account: the display name carries over,
the role is written as a **custom claim**, blocking a user disables the Firebase account so the
sign-in itself fails, and deleting removes it from Firebase too. The app keeps a profile record
for name, phone, role and bookings, joined to the account by `firebase_uid`.

The Admin SDK deliberately cannot verify a password, so sign-in goes through Google's Identity
Toolkit endpoint. That needs the project's **Web API key**, which is discovered automatically from
the Firebase Management API — set `FIREBASE_WEB_API_KEY` only if that lookup fails. Email/Password
sign-in must be enabled in the console under **Authentication → Sign-in method**.

Existing local accounts cannot be migrated automatically, because scrypt hashes cannot be reversed:

```bash
npm run auth:sync                                 # show what would change
npm run auth:sync -- --yes --password=Cinema123   # create the missing accounts
```

It prints every new password once. Firebase Auth pairs with the cloud drivers; on SQLite the
local provider is used.

### Realtime Database vs Firestore

They are separate Firebase products with **separate free-tier allowances**, which matters:

- **Firestore** bills per document read — 50,000 a day on the free plan. Exhaust it and every
  request fails with `RESOURCE_EXHAUSTED` until midnight US Pacific.
- **Realtime Database** bills stored bytes and bandwidth — 1 GB stored, 10 GB downloaded a month.
  This whole dataset is well under a megabyte, so ordinary use costs nothing measurable.

Realtime Database is a single JSON tree with no real queries, so filtering happens in memory —
which the Firestore layer already did anyway. What it does have is `ref.transaction()`, an atomic
compare-and-set with automatic retry, and that is precisely the primitive the seat guard needs.

In practice it is also the faster of the two here: the admin dashboard answers in ~870 ms against
Realtime Database versus ~2,700 ms against Firestore.

### Firestore setup

Both Firebase databases use the same service-account key.

1. Create a project at https://console.firebase.google.com
2. Create the database you want:
   - **Build → Realtime Database → Create database**, or
   - **Build → Firestore Database → Create database** (production mode, `asia-south1`)
3. **Project settings → Service accounts → Generate new private key**
4. Save it as `firebase-key.json` in this folder (git-ignored)

```bash
npm run seed                        # builds the demo data in SQLite
npm run migrate:rtdb                # copies it into Realtime Database
npm run migrate                     # ...or into Firestore
npm run firebase:check              # verifies the Firestore connection
```

The Realtime Database URL is derived from the project id
(`https://<project>-default-rtdb.firebaseio.com`); set `FIREBASE_DATABASE_URL` to override it.

| Script | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with auto-restart on file changes |
| `npm run seed` / `reset` | Build (or rebuild) demo data in SQLite |
| `npm run firebase:check` | Verify the Firebase key and connection |
| `npm run migrate` / `migrate:reset` | Copy SQLite → Firestore |
| `npm run migrate:rtdb` / `migrate:rtdb:reset` | Copy SQLite → Realtime Database |
| `npm run auth:sync` | Create Firebase Auth accounts for existing profiles |
| `npm run clean` | Empty all demo content, keeping admin accounts |

---

## What is in it

### Customer site

| Page | Contents |
|---|---|
| `index.html` | Hero banner with the top-rated film, search, genre chips, Now Showing, Popular, Coming Soon |
| `movies.html` | Full catalogue with search, genre / language / status filters and five sort orders |
| `movie.html` | Poster, synopsis, **director, cast**, age rating, runtime, embedded **trailer**, showtimes filtered by city / cinema / date / time-of-day, reviews |
| `cinemas.html` | All cinemas with screens, seat counts and what is playing; per-cinema schedule |
| `seats.html` | Interactive seat map with Silver / Gold / Recliner tiers and live pricing |
| `checkout.html` | Booking summary → payment, with a live hold countdown and promo codes |
| `ticket.html` | Printable ticket with a real scannable **QR code** |
| `bookings.html` | Upcoming / past bookings, cancel with refund, profile and password change |
| `login.html` | Login, register and **forgot password** |
| `reset-password.html` | Set a new password from a reset link |

Plus: protected pages, mobile navigation, skeleton loaders, empty states, error and success
messages, confirmation dialogs and a six-step booking progress bar.

### Admin panel (`admin.html`)

Everything can be added, **edited** and removed. Nine tabs:

- **Dashboard** — revenue, bookings, today's figures, occupancy, a 14-day revenue **chart**,
  top movies, next shows with fill meters, recent bookings
- **Movies** — full CRUD with **poster and banner upload**, director, cast, trailer, age rating
- **Cinemas** — add / edit / delete, with location
- **Screens** — choose seats per row and how many Silver / Gold / Recliner rows, plus each tier's
  price multiplier; the seat grid is generated automatically
- **Seats** — click seats on a live grid to take them **out of service** or put them back
- **Showtimes** — schedule and edit shows, with an overlap guard per screen
- **Bookings** — search by reference, customer, movie or seat; filter by status; cancel and refund
- **Users** — create staff or customers, edit, reset a password, block, delete, and view any
  user's full **booking history**
- **Promo codes** — create and edit (percent or flat, cap, minimum, expiry, on/off)
- **Media** — upload images in bulk, copy URLs, delete

---

## The booking flow

```
Movie → Cinema & Show → Seats → Summary → Payment → Confirmation → Ticket
```

A progress bar tracks all six steps. Selecting seats creates a **PENDING** booking that holds
them for eight minutes with a visible countdown; the booking only becomes **CONFIRMED** after
the payment provider returns success.

### Pricing

Ticket price = `show.base_price × seat.price_multiplier` (Silver 1.0, Gold 1.5, Recliner 2.2).
On top of the subtotal the summary shows a **booking fee per seat** and a **service fee
percentage**, both configurable. Every figure is recomputed on the server from the stored seat
prices — an amount sent by the browser is ignored, which the test suite checks explicitly.

---

## How double booking is prevented

The two databases enforce it differently, because Firestore has no UNIQUE constraint.

**SQLite** — `booking_seats` has `UNIQUE (show_id, seat_id)`, so the same seat physically cannot
exist twice for one show. Inserts run inside `BEGIN IMMEDIATE ... COMMIT`, so a booking that hits
a taken seat rolls back whole rather than half-booking.

**Firestore** — every taken seat for a show lives in one document, `showSeats/{showId}`:

```js
await db.runTransaction(async (t) => {
  const snap  = await t.get(seatRef);
  const taken = snap.data()?.taken || {};
  for (const s of seats) if (taken[s.seat_id]) throw new Error('SEAT_TAKEN');
  for (const s of seats) taken[s.seat_id] = bookingId;
  t.set(seatRef, { taken }, { merge: true });
  t.set(bookingRef, booking);
});
```

Because that document is read and written in one transaction, two simultaneous requests for the
same seat cannot both succeed — Firestore retries the loser, which then sees the seat as taken
and gets a 409. Uniqueness elsewhere comes from document IDs: `promos/{CODE}` gives one promo per
code, `reviews/{movieId}_{userId}` one review per user per movie.

**Verified, not assumed:** the test suite fires five simultaneous requests for the same seat and
asserts that exactly one wins and four receive a 409.

**Expiring holds** work the same on both. If payment does not complete within the hold window,
`releaseExpiredHolds()` frees the seats and marks the booking `EXPIRED`. It runs before every
availability read and on a 60-second timer.

---

## Project layout

```
server.js                Express app, driver switch, async error handling, hold cleanup
src/
  config.js              All settings and secrets, read from the environment
  payments.js            Payment abstraction + server-side pricing
  firebaseapp.js         The one Firebase app, shared by all three products
  firestore.js           Cloud Firestore connection
  rtdb.js                Realtime Database connection
  rtdbstore.js           Realtime Database data layer
  firebaseauth.js        Firebase Authentication (accounts, roles, sign-in)
  authsync.js            Moves existing accounts into Firebase Auth
  clean.js               Empties demo content
  store.js               Picks the cloud data layer for the driver
  fstore.js              Firestore data layer, including the seat-booking transaction
  db.js                  SQLite schema, connection, transaction helper, hold expiry
  auth.js                scrypt hashing, HMAC cookie sessions, auth middleware
  seed.js                Demo data
  migrate.js             Copies SQLite → Firestore
  firebase-check.js      Verifies the Firebase key and connection
  routes/
    uploads.js           Image upload, listing and delete (shared)
    firestore/           auth, catalog, bookings, admin   (default)
    sqlite/              the same four routes, backed by SQLite
public/
  *.html                 Eleven pages (see the table above)
  css/style.css          One design system: theme tokens, components, responsive rules
  js/app.js              Shared fetch, formatting, navbar, footer, dialogs, skeletons
  js/adminform.js        Modal form builder + image picker used across the admin panel
  js/qr.js               QR code generator (Reed-Solomon, byte mode, no library)
  uploads/               Uploaded images
data/cinema.db           SQLite database
```

---

## Database structure

```
users          id, name, email (unique), phone, password_hash, role, blocked, created_at
movies         id, title, description, genre, language, duration_min, certificate,
               director, cast_list, poster_url, banner_url, trailer_url, release_date, status
cinemas        id, name, city, address
screens        id, cinema_id → cinemas, name, row_count, col_count
seats          id, screen_id → screens, row_label, seat_no, seat_type,
               price_multiplier, disabled        UNIQUE (screen_id, row_label, seat_no)
               (SQLite only — on Firestore these live in the parent screen document)
shows          id, movie_id → movies, screen_id → screens, start_time, base_price, status
                                                 UNIQUE (screen_id, start_time)
bookings       id, booking_ref (unique), user_id → users, show_id → shows,
               subtotal, discount, booking_fee, service_fee, total_amount,
               promo_code, seats_snapshot, status, expires_at, created_at
booking_seats  id, booking_id → bookings, show_id → shows, seat_id → seats, price
                                                 UNIQUE (show_id, seat_id)  ← the guard
payments       id, booking_id → bookings, method, amount, status, provider, message, txn_ref
reviews        id, movie_id, user_id, rating, comment    UNIQUE (movie_id, user_id)
promos         id, code (unique), discount_type, discount_value, max_discount,
               min_amount, active, expires_at
password_resets token (pk), user_id → users, expires_at, used
```

A seat is booked **for a specific show**, never permanently — that is what `booking_seats`
holding both `show_id` and `seat_id` expresses.

---

## API reference

### Auth
| Method | Route |
|---|---|
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout` |
| GET / PATCH | `/api/auth/me` |
| POST | `/api/auth/change-password` |
| POST | `/api/auth/forgot-password` · GET `/api/auth/reset-password/:token` · POST `/api/auth/reset-password` |

### Catalog (public)
| Method | Route | Notes |
|---|---|---|
| GET | `/api/home` | hero, now showing, popular, coming soon |
| GET | `/api/movies` | `?search=&genre=&language=&status=&sort=` |
| GET | `/api/movies/:id` · `/api/movies/:id/shows` | `?date=&city=` |
| GET | `/api/shows/:id` | seat map with booked, out-of-service and prices |
| GET | `/api/cinemas` · `/api/cinemas/:id/shows` | `?city=` / `?date=` |
| GET | `/api/cities` · `/api/genres` · `/api/payment-methods` | |
| GET/POST | `/api/movies/:id/reviews` | POST needs login |

### Booking (login required)
| Method | Route | Notes |
|---|---|---|
| POST | `/api/bookings/hold` | `{show_id, seat_ids[]}` → hold, 409 if taken |
| POST | `/api/bookings/promo/check` | `{booking_id, code}` → full price breakdown |
| POST | `/api/bookings/:id/confirm` | `{method, promo_code}` → 402 if the payment fails |
| POST | `/api/bookings/:id/cancel` · GET `/api/bookings/mine` · GET `/api/bookings/:id` | |

### Admin (admin role required)
| Method | Route |
|---|---|
| GET | `/api/admin/stats` |
| GET/POST/PUT/DELETE | `/api/admin/movies[/:id]`, `/cinemas[/:id]`, `/screens[/:id]`, `/shows[/:id]`, `/users[/:id]`, `/promos[/:id]` |
| GET | `/api/admin/bookings?status=&search=` · POST `/api/admin/bookings/:id/cancel` |
| GET | `/api/admin/users?search=` · `/api/admin/users/:id/bookings` · PATCH `/api/admin/users/:id/block` |
| GET | `/api/admin/screens/:id/seats` · PATCH `/api/admin/seats/disable` |
| GET/POST/DELETE | `/api/admin/uploads[/:name]` |

---

## Security

- Passwords hashed with **scrypt** and a per-user salt, or held by Firebase Authentication;
  never stored or logged in plain text either way
- Sessions are HMAC-SHA256 signed tokens in an `httpOnly`, `sameSite=lax` cookie, `secure` in
  production; password and token comparison use `timingSafeEqual`
- Every SQLite query uses bound parameters, so SQL injection is not possible
- Every value rendered into a page goes through `esc()` to prevent XSS
- **Nothing from the browser is trusted**: prices, fees and totals are recomputed server-side
  from stored seat prices; seat ownership, seat-to-screen membership, show validity, roles and
  booking ownership are all checked on the server
- Admin routes sit behind `requireAdmin`; blocked users are rejected in middleware
- Password reset tokens are random, single-use and time-limited; a forgotten-password request
  answers identically whether or not the account exists, so addresses cannot be enumerated
- Uploads are restricted by MIME type and size, stored under generated names, and the delete
  route only accepts those generated names, so path traversal is not possible
- No card details are ever collected or stored — payment goes through the provider abstraction

### Payments

`src/payments.js` normalises every provider to one `charge()` call returning
`{ status, txn_ref, message, provider }`. `mock` simulates a gateway (including a configurable
failure rate and a PENDING state for pay-at-counter). Adding Stripe or Easypaisa means writing
one provider object — no route changes.

---

## Performance

Firestore charges and waits per read, so read volume drove two rounds of work.

**Batching.** Anything that once ran a query per screen now fetches once per request — shows,
taken seats and seat counts are all resolved from single reads rather than per row. That took
the cinemas page from 17.2s to 1.3s, the dashboard from 9.9s to 2.7s and showtimes from 10.5s
to 1.4s. Customer pages land in 280–580 ms.

**Seats live inside their screen document.** Originally every seat was its own document, so
building a seat map meant reading ~766 documents — enough to exhaust a day's free-tier quota
during testing. A screen's entire seat plan is a few kilobytes, far under Firestore's 1 MiB
document limit, so `screens/{id}` now carries a `seats` array and the whole estate costs one
read per screen: **766 reads down to 9**. Seat ids are preserved, so existing bookings still
point at the right seats, and screens written by an older migration still resolve through a
fallback path. The cache on top holds for ten minutes and is dropped on any seat write.

SQLite has none of these constraints and reads whatever it likes.

---

## Known limits

- **Search** filters in memory, because Firestore has no `LIKE`. Fine for a cinema-sized
  catalogue; a few hundred titles would want Algolia or a search index.
- **A very large screen** would eventually outgrow the embedded seat array; Firestore documents
  cap at 1 MiB, which is roughly 10,000 seats. No real cinema comes close.
- **Email is not wired up.** Password-reset links are returned by the API in development
  (`RESET_REVEAL_LINK`) so the flow is testable; connect a mail service and turn that off.
- **Payments are simulated.** The abstraction is real; the gateway is not.
