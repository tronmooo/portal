// Module-level profile filter state — persists across navigation
let _profileFilterId: string | undefined = undefined;
let _profileFilterName: string = "Me";

export function setDashboardProfileFilter(id: string | undefined, name: string) {
  _profileFilterId = id;
  _profileFilterName = name;
}

export function getDashboardProfileFilter(): { id: string | undefined; name: string } {
  return { id: _profileFilterId, name: _profileFilterName };
}
