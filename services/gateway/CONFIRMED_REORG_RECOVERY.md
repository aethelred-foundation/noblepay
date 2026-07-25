# Optional gateway confirmed-reorg recovery

Use this runbook only when the optional Go gateway reports that its durable
checkpoint is no longer canonical. The gateway cannot roll a projected payment
back safely in place. Recovery is a clean replay from the finalized deployment
boundary, while the old store is retained as incident evidence.

The Node API on port `4008` is a separate service. This procedure applies only
to the optional gateway on port `4018`. In the repository's production Compose
topology, `STORE_PATH` is `/var/lib/noblepay-gateway/store.json` inside the
container and the directory is backed by the `gateway-data` named volume. Do
not point two gateway processes at either the old or replacement volume.

## Preconditions

- Open an incident and record the UTC start time, release commit, image digest,
  host, gateway logs, and the alert that identified the non-canonical
  checkpoint.
- Obtain the archived, finalized `DEPLOYMENT_MANIFEST_JSON`. Independently
  confirm its NoblePay address, `NOBLEPAY_CHAIN_ID`,
  `AETHELRED_NETWORK_ANCHOR_BLOCK`, and
  `AETHELRED_NETWORK_ANCHOR_HASH`, and record the manifest's exact
  `indexer.startBlock`. Do not use a bootstrap checkpoint, an unfinalized
  deployment, or values copied from the quarantined projection.
- Confirm the RPC retains every NoblePay log beginning at the finalized
  manifest's `indexer.startBlock`. This exact field is the configured deployment
  replay boundary; never infer one from the old store, the current checkpoint,
  the current head, or an explorer search.
- Ensure there is free space for the immutable incident copy and a complete
  replacement projection. Keep the gateway at one replica.

The commands below use illustrative absolute paths. Replace them with the
paths recorded for the affected deployment before running anything.

```sh
NOBLEPAY_RECOVERY_ID=20260722T120000Z
NOBLEPAY_ENV_FILE=/secure/noblepay/production.env
NOBLEPAY_COMPOSE_FILE=/opt/noblepay/compose.production.yml
NOBLEPAY_EVIDENCE_DIR=/var/lib/noblepay/incidents/20260722T120000Z
NOBLEPAY_OLD_VOLUME=<CURRENT_COMPOSE_GATEWAY_DATA_VOLUME>
NOBLEPAY_NEW_VOLUME=noblepay-gateway-recovery-20260722T120000Z
NOBLEPAY_OVERRIDE_FILE=/secure/noblepay/gateway-recovery-20260722T120000Z.override.yml
```

## Recovery procedure

1. **Stop gateway traffic and the writer.** Remove port `4018` from any load
   balancer or proxy upstream first. Then stop the optional gateway and confirm
   there is no remaining gateway process. Do not leave a second replica polling
   during evidence capture.

   ```sh
   docker compose --env-file "$NOBLEPAY_ENV_FILE" -f "$NOBLEPAY_COMPOSE_FILE" --profile gateway stop gateway
   docker compose --env-file "$NOBLEPAY_ENV_FILE" -f "$NOBLEPAY_COMPOSE_FILE" --profile gateway ps gateway
   ```

2. **Preserve and quarantine the old durable store.** Resolve
   `NOBLEPAY_OLD_VOLUME` from the stopped deployment's Compose project and
   confirm `docker volume inspect` shows the expected Compose project and
   `gateway-data` labels. Do not choose a volume by name alone. Create a
   restricted incident directory, copy the stopped volume without modifying
   it, record hashes and filesystem metadata, and make the evidence copy
   read-only. Keep both the original named volume and the evidence copy out of
   the replacement configuration. Never edit the checkpoint or delete events
   to make startup pass.

   ```sh
   sudo install -d -m 0700 "$NOBLEPAY_EVIDENCE_DIR"
   docker volume inspect "$NOBLEPAY_OLD_VOLUME" | sudo tee "$NOBLEPAY_EVIDENCE_DIR/gateway-volume.inspect.json"
   NOBLEPAY_OLD_MOUNTPOINT="$(docker volume inspect --format '{{.Mountpoint}}' "$NOBLEPAY_OLD_VOLUME")"
   sudo install -d -m 0700 "$NOBLEPAY_EVIDENCE_DIR/volume"
   sudo cp -a "$NOBLEPAY_OLD_MOUNTPOINT/." "$NOBLEPAY_EVIDENCE_DIR/volume/"
   sudo shasum -a 256 "$NOBLEPAY_EVIDENCE_DIR/volume/store.json" | sudo tee "$NOBLEPAY_EVIDENCE_DIR/gateway-store.sha256"
   sudo stat "$NOBLEPAY_OLD_MOUNTPOINT/store.json" | sudo tee "$NOBLEPAY_EVIDENCE_DIR/gateway-store.stat"
   sudo chmod -R a-w "$NOBLEPAY_EVIDENCE_DIR"
   ```

   Record the original file's `indexer_block` and `indexer_block_hash` in the
   incident, but do not reuse either value as a replay boundary.

3. **Provision a genuinely fresh named volume.** Create a new, incident-labelled
   volume and prove its mountpoint is empty before first use. The gateway creates
   `store.json` on its first atomic range commit. Do not copy, truncate, or move
   the old JSON file into this volume.

   ```sh
   docker volume create --label noblepay.purpose=confirmed-reorg-recovery --label noblepay.incident="$NOBLEPAY_RECOVERY_ID" "$NOBLEPAY_NEW_VOLUME"
   NOBLEPAY_NEW_MOUNTPOINT="$(docker volume inspect --format '{{.Mountpoint}}' "$NOBLEPAY_NEW_VOLUME")"
   test -z "$(sudo find "$NOBLEPAY_NEW_MOUNTPOINT" -mindepth 1 -maxdepth 1 -print -quit)"
   ```

   Create the protected Compose override at `NOBLEPAY_OVERRIDE_FILE` with the
   exact physical volume name created above:

   ```yaml
   services:
     gateway:
       volumes:
         - gateway-recovery-data:/var/lib/noblepay-gateway

   volumes:
     gateway-recovery-data:
       external: true
       name: noblepay-gateway-recovery-20260722T120000Z
   ```

   Render Compose with both files and verify the gateway mount target resolves
   to `NOBLEPAY_NEW_VOLUME`, never the quarantined `gateway-data` volume.

4. **Build recovery configuration only from finalized evidence.** In the secret
   manager or a protected copy of the production environment, set:

   ```text
   INDEXER_START_BLOCK=<DEPLOYMENT_MANIFEST_JSON.indexer.startBlock>
   NOBLEPAY_CONTRACT_ADDRESS=<FINALIZED_MANIFEST_NOBLEPAY_ADDRESS>
   NOBLEPAY_CHAIN_ID=<FINALIZED_MANIFEST_CHAIN_ID>
   AETHELRED_NETWORK_ANCHOR_BLOCK=<FINALIZED_MANIFEST_ANCHOR_BLOCK>
   AETHELRED_NETWORK_ANCHOR_HASH=<FINALIZED_MANIFEST_ANCHOR_HASH>
   INDEXER_CONFIRMATIONS=<REVIEWED_FINALITY_DEPTH>
   ```

   Copy `indexer.startBlock` exactly as a base-10 unsigned integer; do not add or
   subtract a block. `STORE_PATH` remains the image's reviewed
   `/var/lib/noblepay-gateway/store.json`; the override supplies its fresh
   backing volume. Keep the same reviewed RPC and contract deployment. Validate
   the complete environment and rendered two-file Compose configuration before
   restart. A different chain ID, anchor, NoblePay address, replay block, or
   confirmation depth is a separate reviewed deployment decision—not an
   incident workaround.

5. **Restart with traffic still disabled.** Start exactly one gateway using the
   replacement environment. Do not re-add the proxy upstream yet.

   ```sh
   docker compose --env-file "$NOBLEPAY_ENV_FILE" -f "$NOBLEPAY_COMPOSE_FILE" -f "$NOBLEPAY_OVERRIDE_FILE" --profile gateway config
   docker compose --env-file "$NOBLEPAY_ENV_FILE" -f "$NOBLEPAY_COMPOSE_FILE" -f "$NOBLEPAY_OVERRIDE_FILE" --profile gateway up -d --no-deps gateway
   docker compose --env-file "$NOBLEPAY_ENV_FILE" -f "$NOBLEPAY_COMPOSE_FILE" -f "$NOBLEPAY_OVERRIDE_FILE" --profile gateway logs --no-log-prefix gateway
   ```

   Catch-up is intentionally fail-closed. `GET /readyz` must return `503`, and
   authenticated `GET /api/v1/payments` and
   `GET /api/v1/payments/{paymentId}` must return `503` without payment data,
   until the fresh projection has atomically checkpointed through the current
   confirmed head. Signed webhooks remain notification-only and cannot advance
   the projection or checkpoint.

6. **Verify network identity and catch-up.** Independently query the configured
   RPC and compare the results byte-for-byte with the finalized manifest. Use
   the manifest's hexadecimal block quantity for the anchor request.

   ```sh
   curl -fsS -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' '<CHAIN_RPC_URL>'
   curl -fsS -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["<ANCHOR_BLOCK_HEX>",false]}' '<CHAIN_RPC_URL>'
   curl -i http://127.0.0.1:4018/readyz
   curl -i -H 'X-API-Key: <GATEWAY_API_KEY>' http://127.0.0.1:4018/api/v1/payments
   ```

   While catch-up is incomplete, the two gateway HTTP calls above must remain
   `503`. If the RPC lacks historical logs, identity changes, any range fails
   canonicality validation, or readiness becomes stale, leave traffic off. Do
   not put the quarantined projection back into service.

7. **Prove the replacement checkpoint before reopening traffic.** Only after
   `/readyz` returns `200`:

   - read `indexer_block` and `indexer_block_hash` from `store.json` in
     `NOBLEPAY_NEW_VOLUME`;
   - fetch that exact block number from the configured RPC and confirm its hash
     equals `indexer_block_hash`;
   - confirm the block is no higher than the current head minus
     `INDEXER_CONFIRMATIONS` and that the indexer has caught up to that confirmed
     head;
   - reconfirm the chain ID and immutable anchor;
   - compare representative initiation, compliance, settlement, refund, and
     payment-count evidence against canonical logs or an independent explorer;
   - archive the readiness response, checkpoint query, RPC responses, gateway
     logs, and new-store hash in the incident record.

   Re-add port `4018` to the proxy only after all checks pass. Continue watching
   `/readyz`, checkpoint age, and canonical block hashes during the observation
   window.

8. **Archive and retire the old projection.** Ensure the old named volume is not
   mounted by any active configuration, label it non-canonical in the incident
   inventory, and retain the volume plus the read-only evidence copy, digest,
   metadata, logs, manifest, and incident decisions for the applicable
   security/audit retention period. Deletion, if ever permitted, is a separate
   approved evidence-disposition action after incident closure. The old
   projection must never again be used to serve payment reads.

## Abort conditions

Keep traffic disabled and escalate to the chain/operator team if the finalized
manifest is unavailable, historical logs are incomplete, the independent RPC
checks disagree, the fresh checkpoint becomes non-canonical, catch-up stops, or
representative payment projections differ from canonical events. Do not lower
confirmations, skip the anchor, move `INDEXER_START_BLOCK` forward, mutate the
old store, or return stale reads to shorten recovery time.
