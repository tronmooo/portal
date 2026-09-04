# linked_profiles prune — production state before the repair (2026-09-04)

`migrations/20260729_linked_profiles_ownership_guard.sql` was written on 2026-07-29,
applied to the local replica, and never applied to production. This file records
exactly what production held before it was applied, so any association below can be
re-pointed by hand. The migration REMOVES invalid elements; it never re-points.

## Cross-user links (the two the migration's own header documented, still live)

| table | row id | row name | row owner | linked profile | profile name | profile owner |
|---|---|---|---|---|---|---|
| habits | 32394c86-ec39-4a39-b879-ab97513e5cb4 | Drink 8 glasses of water | d2064ce8-527e-493c-a846-159769e81eac | e0654d9a-ab20-4e97-8357-1975dd142b53 | Rex | 6f63cf74-ad8b-42f4-a8de-850f42219c06 |
| trackers | a9c97993-830e-4d4e-8f58-df368a3ed800 | Medication | 6f63cf74-ad8b-42f4-a8de-850f42219c06 | 1e0b9eef-981f-4ecc-a1ab-d33518b2bed2 | Mom | d2064ce8-527e-493c-a846-159769e81eac |

The migration's header notes that the "Medication" tracker's owner has their own
"Mom" profile (fc3a2470-1a87-4703-8897-8c7ecf68d9bb) to re-point to if they want it;
the habit's owner has no "Rex" profile at all, so there is no candidate.

## Dangling links (profile no longer exists)

Rows that look like real user data:

| table | row id | row label | removed link |
|---|---|---|---|
| documents | 7a3b733b-e4d4-4d97-bbc1-a853dd33465b | p10 licence (probe) | 059565cf-77e6-4eaa-b838-f275a1a8652c |
| events | 925d615a-2344-4831-875d-5aefbca68d63 | Phone Bill — Payment Due | 767cdb7d-0650-4bf3-9eef-1f33bbb42882 |
| expenses | 0d46212a-447c-49d2-861b-29e29e9e308b | Coffee | 210cf805-5f60-4ca2-a6ee-3766f7515efa |
| expenses | b9fce36b-3a18-40f8-98c1-fafca370e87a | Groceries | 210cf805-5f60-4ca2-a6ee-3766f7515efa |
| expenses | 55306df3-055f-4fc1-9b71-555f2338aaae | Gas | 2b32841a-0eb3-4c64-b717-29d41f115666 |
| expenses | 40e73433-bfd3-4cf3-9464-bf5509f3e360 | Candy | 918a3e04-7651-4378-b347-4b103a59435c |
| expenses | a5fc3e2e-f34c-4c71-bde7-5057062cdb63 | Gum | d5d13e55-59b8-4b71-990e-a86e7d2f32d3 |
| expenses | 4606e5eb-ecad-4490-a5cf-0b668740c57f | Oil change | 22c60033-ebcb-4858-b943-c2df33964f32 |
| expenses | 53e5b67c-c0c0-4cf1-8171-cf25a389653d | Detail probe tires | 22c60033-ebcb-4858-b943-c2df33964f32 |
| expenses | 49e38538-4533-4b54-bf89-2e5229f58790 | Child shoes STy129 | 91bdbb40-9192-4bd6-9fe0-2b9c7f9ddffc |
| expenses | 528ac277-548f-4908-acff-a2d18496f1bc | Child shoes STybdm | 91bdbb40-9192-4bd6-9fe0-2b9c7f9ddffc |
| tasks | 7718d816-9109-4cbf-94a4-73031f419c7d | Renew car registration | 09d93ee3-5ccd-4425-a1b7-87cb47d15c7e |
| habits | 3e0ee29f-f799-404e-8037-91a179154763 | Floss HB19aa | 91bdbb40-9192-4bd6-9fe0-2b9c7f9ddffc |

Rows that are QA/probe debris (test profiles since deleted): events 4586c507…,
e9287700…, b3aa4ae8… (this session's own p16 probe row, already soft-deleted);
expenses 1536236a…, 1715aa5d…, 31f34126…, 556c38ae…, 566465ce…, 6c58e525… (two
links), 784ac101…, 9d374eae…, a97b0d54…, b3ded64d…, bfb408c0…, d18442ac…,
e7f3df78…, f2b7f748…, ff85bf12…; habits 26216ef3…, 47e43501…, 5f0ef09d…,
65a0f92b…, 85d381d9…, d6077095…, db0ecdb5…, ded4e6ab…; incomes 2bc7b2d8…,
42d9055d…, 6b45c002…, 6bf0010c…; tasks 14b3778b…, 1c6c5643…, 44652e14…,
48c88621…, 4cd57e38…, d51f72ed….

Totals before the repair: 50 dangling links and 2 cross-user links across 51 rows
in documents, events, expenses, habits, incomes, tasks and trackers.
