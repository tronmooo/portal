// A document row's `storage_path` is only honoured inside its owner's folder.
//
// Storage objects live at `${userId}/${docId}.${ext}` and the server reads,
// signs and removes them with the service-role key. The path itself, though,
// sits in a column the row's owner may update through Supabase directly (RLS:
// "Users can update own documents"). A row repointed at
// `<someone-else>/<doc>.pdf` would have had the server sign a download URL
// for — or purge — another account's file. The row is the caller's; the path
// must be too. Anything else is treated as "no file".
export function ownedStoragePath(path: unknown, userId: string): string | undefined {
  if (typeof path !== "string" || !path || !userId) return undefined;
  if (!path.startsWith(`${userId}/`)) return undefined;
  const rest = path.slice(userId.length + 1);
  if (!rest || rest.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) return undefined;
  if (/[\\\0]/.test(rest)) return undefined;
  return path;
}
