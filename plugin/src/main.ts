/**
 * Obsidian Cloudflare E2EE Real-Time Sync Plugin.
 *
 * Provides real-time, end-to-end encrypted synchronization across Desktop, iOS, and Android
 * using Cloudflare Workers, SQLite Durable Objects, and R2.
 */

import {
  App,
  Modal,
  Notice,
  Plugin,
  setIcon,
} from "obsidian";
import { CryptoEngine } from "./crypto/CryptoEngine";
import { LocalDB } from "./storage/LocalDB";
import { BlobClient } from "./sync/BlobClient";
import { SyncEngine } from "./sync/SyncEngine";
import { SyncSettingTab } from "./settings";
import {
  DEFAULT_SETTINGS,
  SyncPluginSettings,
  SyncStats,
} from "./types";

export { SyncEngine } from "./sync/SyncEngine";
export { DEFAULT_SETTINGS } from "./types";

export default class ObsidianCloudflareSyncPlugin extends Plugin {
  settings: SyncPluginSettings = DEFAULT_SETTINGS;
  crypto: CryptoEngine = new CryptoEngine();
  localDb: LocalDB = new LocalDB();
  blobClient!: BlobClient;
  syncEngine: SyncEngine | null = null;
  statusBarItemEl!: HTMLElement;

  async onload(): Promise<void> {
    await this.loadSettings();

    // 1. Initialize data clients
    this.blobClient = new BlobClient(
      this.settings.workerUrl,
      this.settings.authToken
    );

    // 2. Initialize Status Bar Item
    this.statusBarItemEl = this.addStatusBarItem();
    this.statusBarItemEl.addClass("cf-sync-status-bar");
    this.updateStatusBar({
      status: "offline",
      pendingUploads: 0,
      lastSyncTime: 0,
      lastRev: 0,
      errorMessage: null,
    });

    this.statusBarItemEl.addEventListener("click", () => {
      new SyncStatusModal(this.app, this).open();
    });

    // 3. Register Ribbon Icon
    this.addRibbonIcon("refresh-cw", "Cloudflare Sync", async () => {
      if (this.syncEngine) {
        new Notice("Cloudflare Sync: Syncing vault...");
        await this.syncEngine.forceSync();
      } else {
        new Notice("Cloudflare Sync is not configured. Open Settings.");
      }
    });

    // 4. Register Commands in Command Palette
    this.addCommand({
      id: "force-full-sync",
      name: "Force Full Sync",
      callback: async () => {
        if (this.syncEngine) {
          new Notice("Starting full synchronization...");
          await this.syncEngine.forceSync();
          new Notice("Full synchronization complete.");
        } else {
          new Notice("Cloudflare Sync is not configured.");
        }
      },
    });

    this.addCommand({
      id: "show-sync-status",
      name: "Show Sync Status",
      callback: () => {
        new SyncStatusModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: "copy-vault-sync-credentials",
      name: "Copy Vault Sync Credentials",
      callback: async () => {
        const payload = {
          workerUrl: this.settings.workerUrl,
          vaultId: this.settings.vaultId,
          authToken: this.settings.authToken,
          passphrase: this.settings.passphrase,
        };
        const encoded = btoa(encodeURIComponent(JSON.stringify(payload)));
        try {
          await navigator.clipboard.writeText(encoded);
          new Notice("Vault Sync credentials copied! Paste this code on your mobile device.");
        } catch (_) {
          new ShowCredentialsModal(this.app, encoded).open();
        }
      },
    });

    // 5. Register Settings Tab
    this.addSettingTab(new SyncSettingTab(this.app, this));

    // 6. Register Vault File Events
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.settings.autoSync && this.syncEngine) {
          this.syncEngine.handleFileCreated(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.settings.autoSync && this.syncEngine) {
          this.syncEngine.handleFileModified(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.settings.autoSync && this.syncEngine) {
          this.syncEngine.handleFileDeleted(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.settings.autoSync && this.syncEngine) {
          this.syncEngine.handleFileRenamed(file, oldPath);
        }
      })
    );

    // 7. Start Sync Engine if configured
    await this.initSyncEngine();
  }

  onunload(): void {
    if (this.syncEngine) {
      this.syncEngine.destroy();
      this.syncEngine = null;
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.syncEngine) {
      await this.syncEngine.updateSettings(this.settings);
    } else {
      await this.initSyncEngine();
    }
  }

  private async initSyncEngine(): Promise<void> {
    if (
      !this.settings.workerUrl ||
      !this.settings.vaultId ||
      !this.settings.authToken ||
      !this.settings.passphrase
    ) {
      this.updateStatusBar({
        status: "offline",
        pendingUploads: 0,
        lastSyncTime: 0,
        lastRev: 0,
        errorMessage: "Not configured",
      });
      return;
    }

    if (this.syncEngine) {
      this.syncEngine.destroy();
      this.syncEngine = null;
    }

    this.syncEngine = new SyncEngine(
      this.app,
      this.settings,
      this.crypto,
      this.localDb,
      this.blobClient,
      (stats) => this.updateStatusBar(stats)
    );

    await this.syncEngine.start();
  }

  private updateStatusBar(stats: SyncStats): void {
    if (!this.statusBarItemEl) return;

    this.statusBarItemEl.empty();
    this.statusBarItemEl.removeClass(
      "is-syncing",
      "is-synced",
      "is-conflict",
      "is-offline",
      "is-error"
    );

    const iconSpan = this.statusBarItemEl.createSpan({ cls: "cf-sync-icon" });
    const textSpan = this.statusBarItemEl.createSpan({ cls: "cf-sync-text" });

    switch (stats.status) {
      case "syncing":
        this.statusBarItemEl.addClass("is-syncing");
        setIcon(iconSpan, "refresh-cw");
        textSpan.setText(
          stats.pendingUploads > 0 ? `Syncing (${stats.pendingUploads})` : "Syncing..."
        );
        this.statusBarItemEl.title = `Cloudflare Sync: Syncing in progress. ${stats.pendingUploads} items queued.`;
        break;

      case "synced":
        this.statusBarItemEl.addClass("is-synced");
        setIcon(iconSpan, "check");
        textSpan.setText("Synced");
        this.statusBarItemEl.title = `Cloudflare Sync: Synced (Rev: ${stats.lastRev}). Click for details.`;
        break;

      case "conflict":
        this.statusBarItemEl.addClass("is-conflict");
        setIcon(iconSpan, "alert-triangle");
        textSpan.setText("Conflict");
        this.statusBarItemEl.title = "Cloudflare Sync: Conflict detected and resolved.";
        break;

      case "error":
        this.statusBarItemEl.addClass("is-error");
        setIcon(iconSpan, "alert-circle");
        textSpan.setText("Sync Error");
        this.statusBarItemEl.title = `Cloudflare Sync: Error - ${stats.errorMessage || "Unknown error"}`;
        break;

      case "offline":
      default:
        this.statusBarItemEl.addClass("is-offline");
        setIcon(iconSpan, "wifi-off");
        textSpan.setText("Offline");
        this.statusBarItemEl.title = "Cloudflare Sync: Disconnected or offline.";
        break;
    }
  }
}

/**
 * Status and diagnostics modal
 */
class SyncStatusModal extends Modal {
  private plugin: ObsidianCloudflareSyncPlugin;

  constructor(app: App, plugin: ObsidianCloudflareSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cf-sync-modal");

    contentEl.createEl("h2", { text: "Cloudflare Sync Status" });

    const stats = this.plugin.syncEngine
      ? await this.plugin.syncEngine.getStats()
      : {
          status: "offline" as const,
          pendingUploads: 0,
          lastSyncTime: 0,
          lastRev: 0,
          errorMessage: "Plugin not initialized",
        };

    const grid = contentEl.createDiv({ cls: "cf-sync-stat-grid" });

    // Status
    const statusItem = grid.createDiv({ cls: "cf-sync-stat-item" });
    statusItem.createSpan({ cls: "cf-sync-stat-label", text: "Status" });
    const badge = statusItem.createSpan({ cls: "cf-sync-stat-value" });
    badge.addClass("cf-sync-badge");
    badge.setText(stats.status.toUpperCase());
    if (stats.status === "synced") badge.addClass("cf-sync-badge-ok");
    else if (stats.status === "syncing") badge.addClass("cf-sync-badge-warn");
    else if (stats.status === "error" || stats.status === "conflict")
      badge.addClass("cf-sync-badge-err");

    // Revision
    const revItem = grid.createDiv({ cls: "cf-sync-stat-item" });
    revItem.createSpan({ cls: "cf-sync-stat-label", text: "Server Revision" });
    revItem.createSpan({
      cls: "cf-sync-stat-value",
      text: stats.lastRev > 0 ? `#${stats.lastRev}` : "N/A",
    });

    // Pending Items
    const queueItem = grid.createDiv({ cls: "cf-sync-stat-item" });
    queueItem.createSpan({ cls: "cf-sync-stat-label", text: "Pending Queue" });
    queueItem.createSpan({
      cls: "cf-sync-stat-value",
      text: `${stats.pendingUploads} items`,
    });

    // Last Synced
    const timeItem = grid.createDiv({ cls: "cf-sync-stat-item" });
    timeItem.createSpan({ cls: "cf-sync-stat-label", text: "Last Synchronized" });
    timeItem.createSpan({
      cls: "cf-sync-stat-value",
      text: stats.lastSyncTime > 0 ? new Date(stats.lastSyncTime).toLocaleTimeString() : "Never",
    });

    if (stats.errorMessage) {
      const errBox = contentEl.createDiv({ cls: "cf-sync-danger-zone" });
      errBox.createEl("strong", { text: "Error Notice: " });
      errBox.createSpan({ text: stats.errorMessage });
    }

    const btnContainer = contentEl.createDiv({ cls: "cf-sync-btn-container" });

    const syncNowBtn = btnContainer.createEl("button", {
      text: "Force Sync Now",
      cls: "mod-cta",
    });
    syncNowBtn.onclick = async () => {
      if (this.plugin.syncEngine) {
        syncNowBtn.disabled = true;
        syncNowBtn.setText("Syncing...");
        await this.plugin.syncEngine.forceSync();
        new Notice("Sync complete!");
        this.close();
      }
    };

    const closeBtn = btnContainer.createEl("button", { text: "Close" });
    closeBtn.onclick = () => this.close();
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/**
 * Mobile clipboard fallback modal
 */
class ShowCredentialsModal extends Modal {
  private code: string;

  constructor(app: App, code: string) {
    super(app);
    this.code = code;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cf-sync-modal");
    contentEl.createEl("h3", { text: "Vault Sync Setup Code" });
    contentEl.createEl("p", {
      text: "Copy the setup code below to import sync settings on another device:",
    });
    const textarea = contentEl.createEl("textarea");
    textarea.value = this.code;
    textarea.style.width = "100%";
    textarea.style.height = "120px";
    textarea.readOnly = true;

    const btnContainer = contentEl.createDiv({ cls: "cf-sync-btn-container" });
    const closeBtn = btnContainer.createEl("button", { text: "Close" });
    closeBtn.onclick = () => this.close();
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
