// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Frozen analytics exclusion list (t/4960, PI keep-and-filter decision at t/4794#22/#31).
 *
 * Session IDs only — no event content or identities. Three classes, all excluded from
 * analysis by default (see `AnalyticsExclusionOptions` in analytics.ts):
 * - `staging-leak`: sessions from the 2026-11-02 to 2026-11-04 staging/prod container leak
 *   (t/4794), split into user and smoke-probe sessions by Azure's #7/#11/#31 analysis.
 * - `pi-test`: the PI's own anonymous test sessions, identified by Azure via cookie/account
 *   co-occurrence (t/4960#4) — these fall OUTSIDE the staging-leak window, which is why
 *   exclusion is by session ID alone, never gated by `ANALYTICS_EXCLUSION_WINDOW` (TL t/4960#3
 *   condition 1).
 *
 * `ANALYTICS_EXCLUSION_WINDOW` is informational only (documents when the staging-leak subset
 * occurred) — it is NOT a filter condition. Do not gate `ANALYTICS_EXCLUDED_SESSIONS` by date.
 *
 * Two sessions are ambiguous (staging-leak evidence below the 50% match threshold, t/4794#31
 * point 4) and are listed separately — NOT excluded by default; `excludeAmbiguous` opts in.
 *
 * Not included here (Azure t/4960#4): a CONFIRM id (1 session, shares a session only with the
 * PI's other, unnamed account) and 58 near-miss ids — both pending the PI's explicit pick, not
 * part of this exclusion until named.
 */

export type AnalyticsExclusionReason = 'staging-leak' | 'pi-test';

/** Informational only — see module doc. Never used as a filter condition. */
export const ANALYTICS_EXCLUSION_WINDOW = Object.freeze({
  from: '2026-11-02T14:38:00.000Z',
  to: '2026-11-04T15:40:00.000Z',
});

/** 14 staging-leak user sessions (t/4794#31, t/4960#4). */
const STAGING_LEAK_USER_SESSIONS: readonly string[] = [
  '2c7b4a97-9fad-4460-a511-4e6082a98ff9',
  '501c880a-bafa-47a7-8ba7-c6101d02a5e9',
  '52a5c548-238f-451a-ab25-e4a244524069',
  '60dc05c9-056b-4af6-9a6e-ba061369f42f',
  '744e446a-5b86-4b47-bb81-61a9a3c9cb4f',
  '8b400a66-a15a-4367-b635-a59942e89b4c',
  '9aaf1504-d72a-4a6c-9d8f-0d264ad0bf27',
  '9e957cb6-de51-4245-9d8e-4f9b1b467e5a',
  'c18ac257-e35e-4d9a-8a2f-e41edd641cf2',
  'c3c65930-c13f-4d2f-bf8e-28c549329a64',
  'dd9c35fb-5876-49ab-b58e-875b1545d574',
  'e5288907-5d21-4a81-9302-8ef3852c3617',
  'f2218769-a353-4a46-b5c0-77ecba243d69',
  'f8bf8cc4-3b37-4ba6-91c9-b6b01fe53200',
];

/** 6 staging-leak smoke-probe sessions (t/4794#31 point 3, t/4960#4). */
const STAGING_LEAK_SMOKE_SESSIONS: readonly string[] = [
  'smoke-1793630451078',
  'smoke-1793634771438',
  'smoke-1793646448288',
  'smoke-1793650521920',
  'smoke-1793654662057',
  'smoke-1793658936113',
];

/** 160 PI-test sessions (t/4960#4: anon ids co-occurring with a PI signed-in account; +1
 *  delta at t/4960#7 after the PI confirmed more of their own accounts). */
const PI_TEST_SESSIONS: readonly string[] = [
  '4589c3e1-81b5-4eb8-ab6b-9dc7f785ab7f', // t/4960#7 delta
  '02f24e1b-d640-48cd-8562-79387e87a42f', '042ddc5e-585f-41a6-ab6e-583b2c5d39ce',
  '066b1f3c-f2aa-4af4-ac69-2a3232128b8d', '07e36d59-9ace-4a0b-ac6c-3f808229f5db',
  '0b48bc6f-4e0b-4949-b0f3-e9582676a1c8', '0ec0b09e-3222-4c10-b450-feec8f1f250e',
  '0f861a61-4276-4236-bda5-e05c3c42113a', '10c4f4ef-c5b2-4b8d-b7f3-fdf759487bab',
  '130c8ddf-ef2b-4d5b-bbd6-bbbf171631c9', '1500e123-a1cc-4d4f-8609-ec7931e07bc4',
  '157fd7aa-f202-479e-81da-387610b2322e', '1755f4a7-7f2e-4a7d-b0d7-9384b2f7a4b9',
  '1794f1ab-4378-40db-ae93-5c5d04f18b3b', '194d6a43-02c9-422f-a5bd-3e7b3c154d36',
  '1a439812-250e-42ab-9891-abe1f54f0610', '1c3cb27d-16d9-417d-8992-569f95353eed',
  '1c97ab36-53e2-476a-adf3-5e81d879a02b', '1d11b8f9-541f-4aab-b2e0-ca65f5929767',
  '1d14c572-4f1e-4198-90e2-d883397d5236', '1f916f80-b321-48e0-8071-bd4f159e4baf',
  '21e23b79-cf28-4171-95db-0dd528142271', '24276a0a-fc85-4b91-9f19-c8504f1630f5',
  '24f92fe9-e77d-40a9-9285-655452e503ce', '254929bc-1eeb-4b71-bb19-7eeb1de11329',
  '2a854a18-32f8-4694-839c-a111f0c6ee5f', '2aa19d06-4e8e-4e52-9cdc-d543e8e6c8bd',
  '2c16198f-4162-429d-a730-e61eac7c8cde', '2c993be3-9c86-482e-b37a-4a472b99fe9f',
  '2ceeb4c6-2f63-41bc-8f86-2198c5d92e43', '2e5ddae1-3282-4bb3-a512-5fd6e7c80072',
  '2f0dccc6-4ec0-459d-b4f5-fdb3bce23570', '30cc5586-fefd-41c5-8cc2-4a90b917063e',
  '33b6cec2-7d46-49ac-8c3b-8bc873a082e0', '34069657-a490-4f3e-ae04-ec4c790d0cf8',
  '361a9205-aec6-4be7-8545-c5b5c4d853f1', '37d981b6-ed0a-480e-9176-e043f9f94677',
  '3a2f08ca-6cf9-4e15-a66e-cbec551a07db', '3ce6df8a-7728-464b-98b3-a550b23e088f',
  '3e213eb1-0379-4231-8489-e8f17596b4c7', '441c4fc4-cd6b-4eb1-b579-5bf27225943f',
  '4496a8b0-a275-4d14-8a52-d970aa809ca4', '4683d4e0-ec13-4357-a868-438af9a6acb5',
  '49d752b3-899e-4c70-bb93-ffb8e6bf494f', '4deebfe4-5596-400a-bd17-7106fe6a0590',
  '4fc57f99-c1c9-48f9-bd36-6a8d81973bfc', '4fdd2b61-68c9-4683-aa3d-6befe2ac2de6',
  '50579a0f-84e4-4216-a583-f4aaf8de9825', '51129422-6616-40b7-9225-363e83513030',
  '515701b3-09ba-4d09-84d5-61994b65ea40', '523f7d25-25ff-46e0-a793-35e83dc56e8e',
  '527720b3-51f7-4415-bac9-5a4421a0916e', '573e8958-77e8-44a2-a850-21c49f4f99eb',
  '58ac86a5-c6f8-4c3b-8780-4f8b95c8f2ca', '596ad8a4-3d9e-4a30-9396-690c7b135325',
  '59e4724e-5c73-455c-9cba-6a7c9ab972eb', '5ae546a0-edce-4601-bbad-52e97a40d8ae',
  '5d7ea56b-2129-4463-ba39-801c377a8d16', '5d958fb6-d03b-47e7-a9db-c04a2257a7e7',
  '5e7ddea8-d846-4c45-992a-57c99210e821', '60a470cf-edad-4d2b-84d9-5d548af04ab6',
  '61cc008e-e61c-404c-ab05-b5818c7d553b', '623dac49-77f8-4a6a-94ae-ca63f3cfdb7f',
  '65329c6b-4e36-41e4-bb17-b3696eab944c', '657317fa-7314-4ce1-851c-d09df0ce94e4',
  '6a74693e-b2a9-4e96-8774-cfe05a7c3714', '6c105984-de9e-47c8-98a0-0d16ae9f0eda',
  '6dc5a11b-2662-4a7d-98c1-ab1b54a7066b', '6dc9147c-189c-4526-b123-e3406ceee9df',
  '736b391b-45ee-4cc1-b26d-653eec89661d', '76955d9c-b7bc-410e-a739-9c476528e822',
  '7a5fc5f4-bcd3-43a5-8f2f-380d6899b564', '7b73e8b7-c668-4bce-8de0-3da34596bbf4',
  '8089d917-8de1-49ca-ae6d-d62238a63afa', '80b88ea8-f4cb-4ad1-91e2-5f84bcbc3f8f',
  '81f7e5cb-f0b5-43f8-baec-afd95d4ad7b3', '823e3e90-cc31-4456-8e91-ebb6c66cf471',
  '861d7256-de76-46d4-8c40-fe8ced651a6b', '8a975f0d-c1f0-40d0-b0c5-a2cd541d98fb',
  '8b05eb8f-4dba-46da-9447-a9766b654f56', '8b5036ea-710e-46d4-bd15-e6d0b23a4c39',
  '8be8c904-dffe-4618-a2c7-fa201db834c1', '8ea85d16-f92a-45d0-8a87-16dd8a9f1a40',
  '8f3e9b7d-5725-4e0f-9e85-9e9218cfe325', '9044cee0-ea7c-4e85-8681-abed1a6b314d',
  '904dcee7-b7ba-4604-8840-f4f7f2b28a15', '93ada210-115a-4bac-b5f6-f7c883ccab09',
  '94995bc3-3957-46aa-bed9-d7dc165f5b45', '95ecbbea-76cb-4806-b107-edd00bbaea17',
  '96cc8798-3bcb-476c-941b-06f600f9d6f2', '9728bdec-7088-4a30-a002-e467a91e00e1',
  '97852edd-940d-4e30-bd38-da9d7056bddc', '983b4808-e617-49f5-b136-eef5c6a8c1c7',
  '9932c4b6-b420-4d2e-9f36-8d1a3be7147a', '9b74bb5a-1b79-42b9-83de-e747b16c6ba2',
  '9b82c578-a8d3-42c9-896c-519ef8825c98', '9b988387-cada-4397-83e6-ef4f8b1ab28e',
  '9c51bf29-3b61-45d4-8ecc-31fb75a6ac93', '9f05babf-8302-4e8d-83cd-5ae36ff25f06',
  '9f778b29-387c-4398-9c2f-077e8cfa61b7', '9f842df5-879f-4aca-a7e2-6681cefa27e7',
  'a4a9df72-2a72-4add-828b-105613246fdc', 'a539b8ef-b901-4d8e-8215-c9966a5ac6f1',
  'a6739462-6d54-448b-be51-c5cf3f6cda03', 'a678a70d-7b5e-4d1b-b729-83c3e8522e65',
  'a6eaf41d-f5ca-468a-9f85-15f6d8507ada', 'a6eaffcd-ef42-403b-bb29-3e4e99e22b11',
  'a7de9c3b-a889-40aa-a694-b2c4538542da', 'a866fb66-ea2d-4019-a738-1dbfa969de2a',
  'ab17773c-c3ab-42c8-9ed1-c39cd0085502', 'ab5c9c78-959c-47df-af9b-16ed71f92077',
  'ac26ef65-bdff-481c-af30-ee5e7233b26b', 'ac8a6b14-9991-401b-929f-1fc1f4f8d323',
  'ad42a0c2-fff7-4b4a-87df-58035fe0765f', 'af7cbfa1-a2d7-43c5-a458-7ec9889d1f3e',
  'b0fe4ed7-fc51-48d6-98e9-af9d4ef32656', 'b102ad72-332d-43eb-829a-1cd46f1a8c09',
  'b2753f13-ba49-48e5-9859-ecdad5ca06df', 'b3e7e912-7cfd-4e09-9796-e7a872491713',
  'b6e7a10b-0438-4323-ae8f-4c490a984f5a', 'b6ff26be-459f-40d5-97cc-22726ff67734',
  'b702e61b-bbdd-4b73-8617-58d00f4b165a', 'b7470cff-4619-4a84-8fd4-3dafb2e69d0e',
  'bed39705-7cdf-42bb-962a-21b95202fdb0', 'bf21898c-0273-4088-8342-d0c6adb26068',
  'c3820df3-241e-4704-a3c4-62e847a4c674', 'c3e84696-de71-4ca2-9121-ef425fa9e36e',
  'c4c512e3-c6d0-4009-a138-8ff39ebce7bd', 'c62fa02c-8e3d-407f-8385-cac7cb2e49a0',
  'c75a094d-924f-4036-8c74-2e6adf598017', 'cc15832e-d44f-4976-8075-312913272328',
  'cd4d5fac-b108-45a2-9d0c-a85cce6799e8', 'cd695674-f69a-4b5e-b385-209aabffd9b0',
  'd02f1409-0dbe-4a8f-9573-1bae68e7f661', 'd0acdf99-6770-4e28-8ff6-4f6629405569',
  'd221af7d-898b-47e8-b763-f16f2d0a932c', 'd550979d-5495-45b1-b41f-6814cfa6fb7e',
  'd6991434-3689-4ee8-9de3-d84755ccba0e', 'd7937f2d-78c4-4143-b342-25ba5f7728ae',
  'd963f7c2-f41f-4c01-b37b-186c1ed8b2d0', 'dab66aaf-5f2a-4f28-a358-7f3032192834',
  'dc922137-e81e-4f40-90a2-fe6a22412e8e', 'dd2b0d1a-64c4-46b6-8803-583470a481ca',
  'e058d3b6-e4a2-41ca-8866-b4be6cd9e69f', 'e4c4e0da-3315-4b61-9e8a-0c9d215b8068',
  'e5714316-a1de-4830-a15d-9cb875eba46e', 'e5a7d547-abf2-46d5-abb4-ab2467cbf337',
  'e770d2ac-f163-4c09-92e7-f096cb1c3b62', 'e8b69a13-c996-40c4-bcdd-a3c46fc64db6',
  'ec1d0ef2-1961-4fec-a96c-ebd820cc52d8', 'eceba2cd-504a-422c-b319-c12fe73e8ebe',
  'ee48a8b0-b05d-4107-89cf-00bdc8cb9830', 'ef1bc954-e934-4429-9bb9-d70ab3f237f3',
  'f149d859-9ec3-44af-91f3-bf87674130c7', 'f1750744-450a-4b5b-82a3-dcbb495ba283',
  'f313686a-cddb-4451-9888-3425f63efa97', 'f897b4d0-9722-4fa8-9287-980c605eccf5',
  'fa2e97ff-cd72-4ee2-8bef-601833c192c7', 'fd46076a-a442-44bd-9530-9d658fa897b2',
  'febf020f-408c-420f-b3e7-ea3f71997a53',
];

/** Session id -> exclusion reason. `staging-leak` wins on overlap (Azure t/4960#4). */
export const ANALYTICS_EXCLUDED_SESSIONS: ReadonlyMap<string, AnalyticsExclusionReason> = new Map([
  ...STAGING_LEAK_USER_SESSIONS.map((id): [string, AnalyticsExclusionReason] => [id, 'staging-leak']),
  ...STAGING_LEAK_SMOKE_SESSIONS.map((id): [string, AnalyticsExclusionReason] => [id, 'staging-leak']),
  ...PI_TEST_SESSIONS.map((id): [string, AnalyticsExclusionReason] => [id, 'pi-test']),
]);

/** 2 ambiguous staging-leak sessions (t/4794#31 point 4) — NOT excluded by default. */
export const ANALYTICS_AMBIGUOUS_SESSIONS: ReadonlySet<string> = new Set([
  'f5d2c8da-5882-4853-88ee-0d41da8032c0',
  'fcdd0273-e4f1-4670-a3ef-2d4218062bc0',
]);
