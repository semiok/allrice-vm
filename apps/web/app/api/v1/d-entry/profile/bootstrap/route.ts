import { profileGet } from '../../../../../../lib/d-entry/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return profileGet(request, 'bootstrap');
}
