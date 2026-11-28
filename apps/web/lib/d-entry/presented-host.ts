/** The browser cannot open a desktop application on the personal VM. */
export function headlessPresentedHost() {
  return Response.json(
    { name: 'AllRice', available: false, fileManager: null },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
