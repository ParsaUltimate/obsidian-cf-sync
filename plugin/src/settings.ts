/**
 * Obsidian Settings Tab for Cloudflare E2EE Real-Time Sync.
 */

import { App, Notice, PluginSettingTab, Setting, requestUrl } from "obsidian";
import type ObsidianCloudflareSyncPlugin from "./main";

export class SyncSettingTab extends PluginSettingTab {
  plugin: ObsidianCloudflareSyncPlugin;

  constructor(app: App, plugin: ObsidianCloudflareSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Cloudflare E2EE Sync Settings" });

    const desc = containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "End-to-End Encrypted, Real-Time Sync powered by Cloudflare Free Tier (Workers + SQLite Durable Objects + R2). Zero Node.js dependencies, 100% mobile compatible.",
    });
    desc.style.marginBottom = "20px";

    // --- Connection Details ---
    new Setting(containerEl)
      .setName("Cloudflare Worker URL")
      .setDesc("The public HTTPS URL of your deployed Cloudflare Worker (e.g. https://obsidian-realtime-sync.username.workers.dev).")
      .addText((text) =>
        text
          .setPlaceholder("https://obsidian-realtime-sync.your-subdomain.workers.dev")
          .setValue(this.plugin.settings.workerUrl)
          .onChange(async (value) => {
            this.plugin.settings.workerUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Vault Identifier (vaultId)")
      .setDesc("Unique identifier for this vault. Used to route WebSocket rooms and R2 storage prefixes.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. my-obsidian-vault")
          .setValue(this.plugin.settings.vaultId)
          .onChange(async (value) => {
            this.plugin.settings.vaultId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Authentication Secret (AUTH_SECRET)")
      .setDesc("Bearer token matching your Cloudflare Worker's AUTH_SECRET secret variable.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter AUTH_SECRET")
          .setValue(this.plugin.settings.authToken)
          .onChange(async (value) => {
            this.plugin.settings.authToken = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("End-to-End Encryption Passphrase")
      .setDesc("Master passphrase for Zero-Knowledge encryption. Derived via PBKDF2 (100k iterations) into AES-256-GCM and HMAC-SHA256 keys. The server NEVER sees this or your plaintext files.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter master passphrase")
          .setValue(this.plugin.settings.passphrase)
          .onChange(async (value) => {
            this.plugin.settings.passphrase = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Device Name")
      .setDesc("Friendly identifier for this client (e.g., MacBook Pro, iPhone, iPad).")
      .addText((text) =>
        text
          .setPlaceholder("My Obsidian Device")
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // --- Performance & Behavior ---
    containerEl.createEl("h3", { text: "Behavior & Sync Cadence" });

    new Setting(containerEl)
      .setName("Automatic Real-Time Sync")
      .setDesc("Automatically sync local file modifications in real-time as you write.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debounce Delay (ms)")
      .setDesc("Wait time in milliseconds after editing a note before queueing an upload.")
      .addSlider((slider) =>
        slider
          .setLimits(500, 5000, 250)
          .setValue(this.plugin.settings.debounceIntervalMs || 1000)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.debounceIntervalMs = value;
            await this.plugin.saveSettings();
          })
      );

    // --- Exclusions & Ignore Rules ---
    containerEl.createEl("h3", { text: "Exclusions & Ignore Rules" });

    new Setting(containerEl)
      .setName("Sync Conflict Files")
      .setDesc("When enabled, conflict backup files (*.sync-conflict-*) are uploaded to the remote vault. When disabled (recommended), conflict copies remain local.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncConflictFiles || false)
          .onChange(async (value) => {
            this.plugin.settings.syncConflictFiles = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Ignored Paths & Patterns")
      .setDesc("Folder names, path prefixes, or patterns to exclude from synchronization (one per line). System rules (node_modules, .git, .obsidian/workspace*.json, etc.) are always enforced.")
      .addTextArea((textArea) => {
        textArea
          .setPlaceholder("node_modules\n.git\n.obsidian/workspace.json\narchive/*")
          .setValue((this.plugin.settings.ignoredPaths || []).join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.ignoredPaths = value
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            await this.plugin.saveSettings();
          });
        textArea.inputEl.rows = 6;
        textArea.inputEl.cols = 40;
      });

    // --- Actions & Diagnostics ---
    containerEl.createEl("h3", { text: "Diagnostics & Pairing" });

    new Setting(containerEl)
      .setName("Test Backend Connection")
      .setDesc("Verify reachability of your Cloudflare Worker and authorization.")
      .addButton((btn) =>
        btn.setButtonText("Test Connection").onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Testing...");
          try {
            const url = `${this.plugin.settings.workerUrl.replace(/\/+$/, "")}/health`;
            const resp = await requestUrl({ url, method: "GET", throw: false });
            if (resp.status === 200) {
              new Notice("Backend connection SUCCESS! Worker is online and reachable.", 5000);
            } else {
              new Notice(`Worker returned status HTTP ${resp.status}: ${resp.text}`, 7000);
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Failed to reach worker: ${msg}`, 7000);
          } finally {
            btn.setDisabled(false);
            btn.setButtonText("Test Connection");
          }
        })
      );

    new Setting(containerEl)
      .setName("Copy Vault Sync Credentials")
      .setDesc("Generate an encrypted setup payload to easily paste into Obsidian Mobile.")
      .addButton((btn) =>
        btn.setButtonText("Copy Mobile Setup Code").onClick(async () => {
          const payload = {
            workerUrl: this.plugin.settings.workerUrl,
            vaultId: this.plugin.settings.vaultId,
            authToken: this.plugin.settings.authToken,
            passphrase: this.plugin.settings.passphrase,
          };
          const json = JSON.stringify(payload);
          const encoded = btoa(encodeURIComponent(json));
          await navigator.clipboard.writeText(encoded);
          new Notice("Sync setup code copied to clipboard! Paste it on mobile.", 6000);
        })
      );

    new Setting(containerEl)
      .setName("Import Sync Setup Code")
      .setDesc("Import settings from a copied setup code from another device.")
      .addText((text) => {
        text.setPlaceholder("Paste setup code here");
        text.inputEl.style.width = "180px";
      })
      .addButton((btn) =>
        btn.setButtonText("Import").onClick(async () => {
          const inputEl = btn.buttonEl.parentElement?.querySelector("input");
          const code = inputEl?.value.trim();
          if (!code) {
            new Notice("Please enter a setup code first.");
            return;
          }
          try {
            const json = decodeURIComponent(atob(code));
            const parsed = JSON.parse(json);
            if (parsed.workerUrl && parsed.vaultId && parsed.authToken && parsed.passphrase) {
              this.plugin.settings.workerUrl = parsed.workerUrl;
              this.plugin.settings.vaultId = parsed.vaultId;
              this.plugin.settings.authToken = parsed.authToken;
              this.plugin.settings.passphrase = parsed.passphrase;
              await this.plugin.saveSettings();
              new Notice("Settings imported successfully! Re-initializing sync...", 5000);
              this.display();
            } else {
              new Notice("Invalid setup code format.");
            }
          } catch {
            new Notice("Failed to decode setup code.");
          }
        })
      );

    new Setting(containerEl)
      .setName("Force Full Vault Sync")
      .setDesc("Trigger an immediate scan of all local files and request server delta.")
      .addButton((btn) =>
        btn.setButtonText("Sync Now").setCta().onClick(async () => {
          if (this.plugin.syncEngine) {
            new Notice("Starting full synchronization...");
            await this.plugin.syncEngine.forceSync();
            new Notice("Synchronization complete!");
          } else {
            new Notice("Sync engine is not running. Check configuration.");
          }
        })
      );

    // --- Reset State ---
    const dangerZone = containerEl.createDiv({ cls: "cf-sync-danger-zone" });
    dangerZone.createEl("h4", {
      text: "Reset Local Sync State",
      cls: "text-error",
    });
    dangerZone.createEl("p", {
      text: "Clears the local IndexedDB synchronization database (resets local revision counter to 0). Local files on disk will NOT be deleted. Use this if you change passphrases or need to re-download all remote files.",
    });

    const resetBtn = dangerZone.createEl("button", {
      text: "Reset Local DB Cache",
      cls: "mod-warning",
    });
    resetBtn.onclick = async () => {
      if (this.plugin.localDb) {
        await this.plugin.localDb.clearAll();
        new Notice("Local IndexedDB sync cache cleared. Starting fresh delta sync...", 6000);
        if (this.plugin.syncEngine) {
          await this.plugin.syncEngine.forceSync();
        }
      }
    };
  }
}
