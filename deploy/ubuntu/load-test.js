// k6 load test — 500 people signed in and working at once.
//
// Run from another machine on the LAN, never from the server, and out of
// office hours:
//
//   brew install k6            # or: https://k6.io/docs/get-started/installation/
//   K6_USER=<code> K6_PASS=<password> k6 run deploy/ubuntu/load-test.js
//
// Watch `pm2 monit` on the server while it runs. Read-only: every request is a
// GET, so it changes no data. See "Capacity and load testing" in README.md for
// how to read the result.
import http from 'k6/http';
import { check, sleep } from 'k6';

const API = __ENV.K6_API || 'https://talenthub.dbl-group.com/api';

export const options = {
  stages: [
    { duration: '1m', target: 100 }, // ramp up
    { duration: '2m', target: 300 },
    { duration: '3m', target: 500 }, // hold 500 users
    { duration: '1m', target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'], // under 1% errors
    http_req_duration: ['p(95)<1500'], // 95% of requests under 1.5 s
  },
};

// Sign in once and share the token: sign-in is rate-limited and locks an
// account after failed attempts, so 500 logins a second is not a test of
// anything useful.
export function setup() {
  const r = http.post(
    `${API}/auth/login`,
    JSON.stringify({ identifier: __ENV.K6_USER, password: __ENV.K6_PASS }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const token = r.json('data.token');
  if (!token) throw new Error(`Sign-in failed (${r.status}): ${r.body}`);
  return { token };
}

export default function ({ token }) {
  const h = { headers: { Authorization: `Bearer ${token}` } };
  const res = [
    http.get(`${API}/dashboard`, h),
    http.get(`${API}/requisitions`, h),
    http.get(`${API}/requisitions/stats`, h),
    http.get(`${API}/notifications/unread-count`, h),
    http.get(`${API}/me/permissions`, h),
  ];
  res.forEach((r) => check(r, { 'status 200': (x) => x.status === 200 }));
  sleep(5 + Math.random() * 5); // a person reads for 5–10 s between clicks
}
