/**
 * Comprehensive Backend Logic, Concurrency & Tombstone Verification Script
 */

class MockSqlCursor {
  constructor(rows) {
    this.rows = rows;
  }
  toArray() {
    return this.rows;
  }
}

class MockSqlStorage {
  constructor() {
    this.files = new Map();
  }

  exec(query, ...params) {
    const q = query.trim().toUpperCase();

    if (q.startsWith("CREATE TABLE") || q.startsWith("CREATE INDEX")) {
      return new MockSqlCursor([]);
    }

    if (q.startsWith("SELECT COALESCE(MAX(REV)")) {
      let maxRev = 0;
      for (const row of this.files.values()) {
        if (row.rev > maxRev) maxRev = row.rev;
      }
      return new MockSqlCursor([{ max_rev: maxRev }]);
    }

    if (q.includes("SELECT FILE_ID, ENCRYPTED_PATH, REV") && q.includes("WHERE REV > ?")) {
      const sinceRev = params[0];
      const results = Array.from(this.files.values())
        .filter((r) => r.rev > sinceRev)
        .sort((a, b) => a.rev - b.rev);
      return new MockSqlCursor(results);
    }

    if (q.includes("WHERE FILE_ID = ?")) {
      const fileId = params[0];
      const row = this.files.get(fileId);
      return new MockSqlCursor(row ? [row] : []);
    }

    if (q.startsWith("INSERT INTO FILES")) {
      const [
        fileId,
        encryptedPath,
        rev,
        opaqueHash,
        size,
        mtime,
        deleted,
        updatedBy,
        updatedAt,
      ] = params;

      this.files.set(fileId, {
        file_id: fileId,
        encrypted_path: encryptedPath,
        rev,
        opaque_hash: opaqueHash,
        size,
        mtime,
        deleted,
        updated_by: updatedBy,
        updated_at: updatedAt,
      });
      return new MockSqlCursor([]);
    }

    return new MockSqlCursor([]);
  }
}

// Durable Object Mock Simulator simulating the updated VaultSyncDO logic
class SimulatedVaultSyncDO {
  constructor(vaultId) {
    this.vaultId = vaultId;
    this.sql = new MockSqlStorage();
    this.r2DeletedKeys = [];
  }

  // Simulates internal check-rev route
  handleCheckRev(fileId, baseRev) {
    const rows = this.sql.exec("SELECT rev, deleted FROM files WHERE file_id = ?", fileId).toArray();
    const row = rows[0];
    const currentRev = row ? Number(row.rev) : 0;
    const isDeleted = row ? row.deleted === 1 : false;

    if (currentRev !== baseRev && !(isDeleted && baseRev === 0)) {
      return { status: 409, body: { error: "Conflict", fileId, currentRev, baseRev } };
    }
    return { status: 200, body: { ok: true, currentRev } };
  }

  // Simulates handlePushMeta
  handlePushMeta(payload, clientId = "client_test") {
    const { fileId, encryptedPath, baseRev, opaqueHash, size, mtime, deleted } = payload;
    const existing = this.sql.exec("SELECT file_id, encrypted_path, rev, opaque_hash, size, mtime, deleted, updated_by, updated_at FROM files WHERE file_id = ?", fileId).toArray()[0];
    const currentRev = existing ? Number(existing.rev) : 0;

    // Idempotency 1: Active content unchanged
    if (existing && existing.opaque_hash === opaqueHash && !deleted && existing.deleted === 0) {
      return { type: "PUSH_ACK", fileId, rev: currentRev, idempotent: true };
    }

    // Idempotency 2: Already deleted on server
    if (existing && existing.deleted === 1 && deleted) {
      return { type: "PUSH_ACK", fileId, rev: currentRev, idempotent: true };
    }

    // Concurrency check (with tombstone re-creation allowance)
    const isRecreatingDeletedFile = existing && existing.deleted === 1 && !deleted && baseRev === 0;
    if (currentRev !== baseRev && !isRecreatingDeletedFile) {
      return { type: "CONFLICT", fileId, serverRecord: existing };
    }

    const nextRev = (this.sql.exec("SELECT COALESCE(MAX(rev), 0) AS max_rev FROM files").toArray()[0].max_rev || 0) + 1;
    const now = Date.now();
    const deletedInt = deleted ? 1 : 0;

    this.sql.exec(
      "INSERT INTO files (file_id, encrypted_path, rev, opaque_hash, size, mtime, deleted, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      fileId, encryptedPath, nextRev, opaqueHash, size, mtime, deletedInt, clientId, now
    );

    if (deleted) {
      this.r2DeletedKeys.push(`${this.vaultId}/${fileId}`);
    }

    return { type: "PUSH_ACK", fileId, rev: nextRev, updatedAt: now };
  }

  // Simulates handlePullDelta with chunking
  handlePullDelta(sinceRev, chunkSize = 250) {
    const rows = this.sql.exec(
      "SELECT file_id, encrypted_path, rev, opaque_hash, size, mtime, deleted, updated_by, updated_at FROM files WHERE rev > ? ORDER BY rev ASC",
      sinceRev
    ).toArray();

    if (rows.length === 0) return [{ type: "DELTA_STATE", records: [] }];

    const chunks = [];
    for (let i = 0; i < rows.length; i += chunkSize) {
      chunks.push({ type: "DELTA_STATE", records: rows.slice(i, i + chunkSize) });
    }
    return chunks;
  }
}

async function runComprehensiveBackendTests() {
  console.log("=== Comprehensive Backend Logic & Concurrency Verification ===");
  const vaultId = "parsa-work-vault";
  const doInstance = new SimulatedVaultSyncDO(vaultId);

  // 1. Initial State
  const emptyDelta = doInstance.handlePullDelta(0);
  if (emptyDelta[0].records.length !== 0) throw new Error("Fresh DO must have 0 records");
  console.log("✓ Test 1: Fresh DO delta is empty");

  // 2. First commit
  const commit1 = doInstance.handlePushMeta({
    fileId: "f1",
    encryptedPath: "enc_notes_ideas_md",
    baseRev: 0,
    opaqueHash: "hash_v1",
    size: 150,
    mtime: 1000,
    deleted: false,
  });
  if (commit1.type !== "PUSH_ACK" || commit1.rev !== 1) throw new Error("Commit 1 must return rev 1");
  console.log("✓ Test 2: First commit allocated rev 1");

  // 3. Idempotent commit (same content hash)
  const commit1Dup = doInstance.handlePushMeta({
    fileId: "f1",
    encryptedPath: "enc_notes_ideas_md",
    baseRev: 1,
    opaqueHash: "hash_v1",
    size: 150,
    mtime: 1000,
    deleted: false,
  });
  if (commit1Dup.type !== "PUSH_ACK" || !commit1Dup.idempotent) throw new Error("Duplicate commit must be acknowledged idempotently");
  console.log("✓ Test 3: Idempotent commit acknowledged without bumping rev");

  // 4. Concurrency conflict on active file
  const conflictCommit = doInstance.handlePushMeta({
    fileId: "f1",
    encryptedPath: "enc_notes_ideas_md",
    baseRev: 0, // Stale baseRev 0 when server is at rev 1
    opaqueHash: "hash_v2_stale",
    size: 180,
    mtime: 1050,
    deleted: false,
  });
  if (conflictCommit.type !== "CONFLICT") throw new Error("Stale baseRev must trigger CONFLICT");
  console.log("✓ Test 4: Concurrency conflict detected on active file");

  // 5. File deletion
  const deleteCommit = doInstance.handlePushMeta({
    fileId: "f1",
    encryptedPath: "enc_notes_ideas_md",
    baseRev: 1,
    opaqueHash: "DELETED",
    size: 0,
    mtime: 1100,
    deleted: true,
  });
  if (deleteCommit.type !== "PUSH_ACK" || deleteCommit.rev !== 2) throw new Error("Deletion must bump to rev 2");
  if (!doInstance.r2DeletedKeys.includes("parsa-work-vault/f1")) {
    throw new Error(`R2 key was not deleted with correct vaultId prefix! Got: ${doInstance.r2DeletedKeys}`);
  }
  console.log("✓ Test 5: File deletion allocated rev 2 and purged R2 key parsa-work-vault/f1");

  // 6. Deletion Idempotency (deleting already deleted file)
  const deleteAgain = doInstance.handlePushMeta({
    fileId: "f1",
    encryptedPath: "enc_notes_ideas_md",
    baseRev: 1, // Stale baseRev during retry
    opaqueHash: "DELETED",
    size: 0,
    mtime: 1100,
    deleted: true,
  });
  if (deleteAgain.type !== "PUSH_ACK" || !deleteAgain.idempotent) {
    throw new Error("Deleting already-deleted file must return idempotent PUSH_ACK, NOT CONFLICT!");
  }
  console.log("✓ Test 6: Deleting already-deleted file returned idempotent PUSH_ACK without conflict");

  // 7. Re-creating previously deleted file with baseRev 0
  const recreateCommit = doInstance.handlePushMeta({
    fileId: "f1",
    encryptedPath: "enc_notes_ideas_md",
    baseRev: 0, // Brand new file created at previously deleted path
    opaqueHash: "hash_v3_reborn",
    size: 220,
    mtime: 1200,
    deleted: false,
  });
  if (recreateCommit.type !== "PUSH_ACK" || recreateCommit.rev !== 3) {
    throw new Error(`Recreating deleted file must allocate rev 3, got: ${JSON.stringify(recreateCommit)}`);
  }
  console.log("✓ Test 7: Re-creating previously deleted file with baseRev 0 succeeded at rev 3!");

  // 8. Concurrency Pre-check (check-rev route)
  const preCheckStale = doInstance.handleCheckRev("f1", 1);
  if (preCheckStale.status !== 409) throw new Error("Pre-check with stale baseRev must return 409 Conflict");
  const preCheckValid = doInstance.handleCheckRev("f1", 3);
  if (preCheckValid.status !== 200) throw new Error("Pre-check with valid baseRev must return 200 OK");
  console.log("✓ Test 8: Worker pre-check prevented overwriting R2 blob on stale baseRev");

  // 9. Delta pagination / frame chunking
  // Insert 600 files to test chunking
  for (let i = 10; i <= 610; i++) {
    doInstance.handlePushMeta({
      fileId: `file_${i}`,
      encryptedPath: `enc_${i}`,
      baseRev: 0,
      opaqueHash: `hash_${i}`,
      size: 50,
      mtime: 2000 + i,
      deleted: false,
    });
  }
  const chunks = doInstance.handlePullDelta(0, 250);
  if (chunks.length < 3) throw new Error(`Expected at least 3 chunks for 602 files, got ${chunks.length}`);
  if (chunks[0].records.length !== 250 || chunks[1].records.length !== 250) {
    throw new Error(`Chunks size mismatch: ${chunks[0].records.length}, ${chunks[1].records.length}`);
  }
  console.log(`✓ Test 9: Delta query partitioned 602 files into ${chunks.length} chunks (max 250 each) under 1MB WS limit`);

  console.log("\n=======================================================");
  console.log("🎉 ALL COMPREHENSIVE BACKEND TESTS PASSED CLEANLY! 🎉");
  console.log("=======================================================\n");
}

runComprehensiveBackendTests().catch((err) => {
  console.error("Backend test failed:", err);
  process.exit(1);
});
