import { profileGet } from '../../../../../../lib/d-entry/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return profileGet(request, 'bootstrap');
}

// The private bootstrap is single-use for its page scope.
export function HEAD() {
  return new Response(null, {
    status: 405,
    headers: { Allow: 'GET', 'Cache-Control': 'private, no-store' },
  });
}
