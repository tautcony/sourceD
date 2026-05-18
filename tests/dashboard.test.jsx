import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { App as AntdApp } from "antd";
import DashboardApp from "../src/dashboard/App.jsx";
import VersionPanel, { versionFilesCache } from "../src/dashboard/VersionPanel.jsx";
import * as popupSourceMapHelpers from "../src/popup/sourcemap.mjs";

vi.mock("../src/popup/sourcemap.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    downloadGroup: vi.fn((...args) => actual.downloadGroup(...args)),
  };
});

const messageApi = {
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
};
const modalApi = {
  info: vi.fn(),
  error: vi.fn(),
};

vi.spyOn(AntdApp, "useApp").mockImplementation(() => ({ message: messageApi, modal: modalApi }));

// Minimal valid source map with embedded sources
function makeSourceMap(sources, sourcesContent) {
  return JSON.stringify({ version: 3, file: "bundle.js", sources, sourcesContent, mappings: "AAAA", names: [] });
}

const longUrl = "https://very-long-subdomain.example-website-with-extremely-long-name.com/very/deeply/nested/path/to/application/page";
const longSiteKey = "very-long-subdomain.example-website-with-extremely-long-name.com";

const sourceMapContent = makeSourceMap(["src/index.js", "src/utils.js"], ['console.log("hello");', 'export function add(a,b){return a+b;}']);

const mockPages = [
  {
    pageUrl: longUrl,
    title: "Example App With A Very Long Title That Should Be Truncated",
    siteKey: longSiteKey,
    versions: [
      { id: "v1", label: "v1.0.0-beta.really-long-version-label", createdAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:00:00Z", mapCount: 3, byteSize: 1024 },
    ],
  },
];

const mockDistribution = [
  { siteKey: longSiteKey, versionCount: 5, mapCount: 12, byteSize: 102400 },
  { siteKey: "another-very-long-example-site-domain.org", versionCount: 3, mapCount: 8, byteSize: 51200 },
];

// version files mock response
const mockVersionFiles = [
  { url: "https://example.com/bundle.js.map", content: sourceMapContent },
];

function mockDashboardData(data, extraHandlers = {}) {
  chrome.runtime.sendMessage = vi.fn((msg, cb) => {
    if (msg.action === "getDashboardData") {
      cb({
        pages: data.pages || [],
        distribution: data.distribution || [],
        settings: data.settings || { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true, detectionEnabled: true, ignoredDomains: [], fetchDelayMs: 300, fetchTimeoutMs: 30000, maxMapBytes: 52428800 },
        totalVersions: data.totalVersions || 0,
        totalStorageBytes: data.totalStorageBytes || 0,
      });
    } else if (extraHandlers[msg.action]) {
      extraHandlers[msg.action](msg, cb);
    } else if (msg.action === "getVersionFiles") {
      cb({ ok: true, files: data.versionFiles || mockVersionFiles });
    } else if (msg.action === "deleteVersion") {
      cb({ ok: true });
      // Simulate reload by calling getDashboardData again
    } else if (msg.action === "updateSettings") {
      cb({ ok: true });
    } else {
      cb(null);
    }
  });
}

async function expandDomain(siteKey = longSiteKey) {
  const domainTitles = await screen.findAllByText((content) => content.includes(siteKey));
  const domainTitle = domainTitles[0];
  fireEvent.click(domainTitle.closest(".ant-collapse-header"));
}

async function activatePageTab(pageText = "Example App") {
  const pageLabels = await screen.findAllByText((content) => content.includes(pageText));
  const pageLabel = pageLabels.find((node) => node.closest(".ant-tabs-tab")) || pageLabels[0];
  const tabNode = pageLabel.closest(".ant-tabs-tab");
  if (tabNode && tabNode.getAttribute("aria-selected") !== "true") {
    fireEvent.click(tabNode);
  }
  return pageLabel;
}

async function openVersionPanel({
  siteKey = longSiteKey,
  pageText = "Example App",
  versionText = "v1.0.0-beta",
} = {}) {
  await expandDomain(siteKey);
  await activatePageTab(pageText);
  const versionTitle = await screen.findByText((content) => content.includes(versionText));
  fireEvent.click(versionTitle.closest(".ant-collapse-header"));
}

// Mock FileReader for download tests
class MockFileReader {
  readAsDataURL() {
    setTimeout(() => {
      this.result = "data:application/zip;base64,AAAA";
      if (this.onloadend) this.onloadend();
    }, 0);
  }
}

beforeEach(() => {
  globalThis.FileReader = MockFileReader;
  chrome.downloads.download = vi.fn((opts, cb) => { if (cb) cb(1); });
  versionFilesCache.clear();
  messageApi.success.mockReset();
  messageApi.info.mockReset();
  messageApi.error.mockReset();
  modalApi.info.mockReset();
  modalApi.error.mockReset();
});

describe("DashboardApp", () => {
  afterEach(() => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => { if (cb) cb(null); });
  });
  it("renders dashboard title", () => {
    render(<DashboardApp />);
    expect(screen.getByText("SourceD History")).toBeInTheDocument();
  });

  it("renders refresh button", () => {
    render(<DashboardApp />);
    expect(screen.getByText("Refresh")).toBeInTheDocument();
  });

  it("renders summary cards", () => {
    render(<DashboardApp />);
    expect(screen.getByText("Tracked Pages")).toBeInTheDocument();
    expect(screen.getByText("Stored Versions")).toBeInTheDocument();
    expect(screen.getByText("Source Map Size")).toBeInTheDocument();
  });

  it("renders section titles", () => {
    render(<DashboardApp />);
    expect(screen.getByText("History")).toBeInTheDocument();
    expect(screen.getByText("Data Distribution")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("renders settings form fields", () => {
    render(<DashboardApp />);
    expect(screen.getByText("Retention Days")).toBeInTheDocument();
    expect(screen.getByText("Max Versions Per Page")).toBeInTheDocument();
    expect(screen.getAllByText("Enable source map detection").length).toBeGreaterThan(0);
    expect(screen.getByText("Save Settings")).toBeInTheDocument();
  });

  it("shows empty history when no pages", async () => {
    render(<DashboardApp />);
    await screen.findByText("No history yet.");
    expect(screen.getByText("No history yet.")).toBeInTheDocument();
  });

  it("shows empty distribution when no data", async () => {
    render(<DashboardApp />);
    await screen.findByText("No distribution data yet.");
    expect(screen.getByText("No distribution data yet.")).toBeInTheDocument();
  });

  it("renders with pages data", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    // Should show domain in collapse - may be truncated, so check it exists
    await screen.findByText((content) => content.includes(longSiteKey));
    expect(screen.getByText((content) => content.includes(longSiteKey))).toBeInTheDocument();
  });

  it("renders distribution pie chart", async () => {
    mockDashboardData({ distribution: mockDistribution });
    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));
    expect(screen.getByRole("img", { name: "Storage distribution pie chart" })).toBeInTheDocument();
    expect(screen.getByText("5 versions · 12 maps · 100.00 KiB")).toBeInTheDocument();
  }, 15000);

  it("distribution legend uses ellipsis for long site keys", async () => {
    mockDashboardData({ distribution: mockDistribution });
    const { container } = render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));
    const ellipsisNodes = container.querySelectorAll(".ant-typography-ellipsis");
    expect(ellipsisNodes.length).toBeGreaterThan(0);
    expect(screen.getByTestId("dashboard-distribution-legend")).toHaveStyle({
      maxHeight: "220px",
      overflowY: "auto",
    });
  });

  it("injects CSS to fix collapse header overflow", () => {
    render(<DashboardApp />);
    const styleTags = document.querySelectorAll("style");
    const matchingTag = Array.from(styleTags).find((s) => s.textContent.includes("ant-collapse-header-text"));
    expect(matchingTag).toBeTruthy();
    expect(matchingTag.textContent).toContain("overflow");
  });

  it("domain label uses ellipsis for long site keys", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    const { container } = render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));
    // The site key text should have ellipsis class
    const siteKeyEl = container.querySelector(".ant-typography-ellipsis");
    expect(siteKeyEl).toBeTruthy();
  });

  it("renders cleanup button", () => {
    render(<DashboardApp />);
    expect(screen.getByText("Optimize Storage")).toBeInTheDocument();
  });

  it("imports uploaded source map files from dashboard", async () => {
    mockDashboardData({ pages: [], totalVersions: 0, totalStorageBytes: 0 }, {
      importSourceMaps: (msg, cb) => {
        cb({
          ok: true,
          reusedExisting: false,
          importedCount: 1,
          rejectedFiles: [],
        });
      },
    });

    render(<DashboardApp />);
    fireEvent.click(screen.getByText("Import Maps").closest("button"));

    const pageUrlInput = await screen.findByLabelText("Page URL");
    fireEvent.change(pageUrlInput, { target: { value: "https://example.com/app" } });
    fireEvent.change(screen.getByLabelText("Page Title"), { target: { value: "Imported Page" } });

    const file = new File(["{}"], "app.js.map", { type: "application/json" });
    Object.defineProperty(file, "text", {
      value: vi.fn().mockResolvedValue(makeSourceMap(["src/index.js"], ['console.log("imported");'])),
    });

    fireEvent.change(screen.getByLabelText("Source map files"), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "importSourceMaps",
          pageUrl: "https://example.com/app",
          title: "Imported Page",
          files: [
            expect.objectContaining({
              name: "app.js.map",
              mapUrl: "app.js.map",
            }),
          ],
        }),
        expect.any(Function),
      );
    });

    await waitFor(() => {
      expect(messageApi.success).toHaveBeenCalledWith("Imported 1 source map files as a new version");
    });
  }, 15000);

  it("imports uploaded source map files via FileReader fallback", async () => {
    const OriginalFileReader = globalThis.FileReader;
    try {
      globalThis.FileReader = class {
        readAsText() {
          this.result = makeSourceMap(["src/fallback.js"], ['console.log("reader");']);
          if (this.onload) this.onload();
        }
      };

      mockDashboardData({ pages: [], totalVersions: 0, totalStorageBytes: 0 }, {
        importSourceMaps: (msg, cb) => {
          cb({ ok: true, reusedExisting: true, importedCount: 1, rejectedFiles: ["bad.map"] });
        },
      });

      render(<DashboardApp />);
      fireEvent.click(screen.getByText("Import Maps").closest("button"));

      fireEvent.change(await screen.findByLabelText("Page URL"), {
        target: { value: "https://example.com/fallback" },
      });

      const file = new File(["{}"], "fallback.js.map", { type: "application/json" });
      Object.defineProperty(file, "text", { value: undefined });

      fireEvent.change(screen.getByLabelText("Source map files"), {
        target: { files: [file] },
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
      });

      fireEvent.click(screen.getByRole("button", { name: "Import" }));

      await waitFor(() => {
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "importSourceMaps",
            pageUrl: "https://example.com/fallback",
            files: [
              expect.objectContaining({
                mapUrl: "fallback.js.map",
                content: expect.stringContaining("\"version\":3"),
              }),
            ],
          }),
          expect.any(Function),
        );
      });

      await waitFor(() => {
        expect(messageApi.success).toHaveBeenCalledWith("Matched an existing version with 1 source map files · 1 files were skipped");
      });
    } finally {
      globalThis.FileReader = OriginalFileReader;
    }
  }, 15000);

  it("shows import failure message", async () => {
    mockDashboardData({ pages: [], totalVersions: 0, totalStorageBytes: 0 }, {
      importSourceMaps: (_msg, cb) => {
        cb({ ok: false, error: "import exploded" });
      },
    });

    render(<DashboardApp />);
    fireEvent.click(screen.getByText("Import Maps").closest("button"));

    fireEvent.change(await screen.findByLabelText("Page URL"), {
      target: { value: "https://example.com/fail" },
    });

    const file = new File(["{}"], "fail.js.map", { type: "application/json" });
    Object.defineProperty(file, "text", {
      value: vi.fn().mockResolvedValue(makeSourceMap(["src/fail.js"], ['console.log("fail");'])),
    });

    fireEvent.change(screen.getByLabelText("Source map files"), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => {
      expect(messageApi.error).toHaveBeenCalledWith("import exploded");
    });
  }, 15000);

  it("shows summary card values from data", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 5, totalStorageBytes: 1048576 });
    const { container } = render(<DashboardApp />);
    await screen.findByText("5");
    // Check storage display
    expect(screen.getByText("1.00 MiB")).toBeInTheDocument();
    // Check statistic values exist in card containers
    const statValues = container.querySelectorAll(".ant-statistic-content-value-int");
    const values = Array.from(statValues).map((el) => el.textContent);
    expect(values).toContain("1"); // 1 page
    expect(values).toContain("5"); // 5 versions
  });

  it("logs raw and stored dashboard storage totals to console", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    mockDashboardData({
      pages: [{
        pageUrl: "https://example.com/app",
        title: "Example",
        siteKey: "https://example.com",
        versions: [{
          id: "v1",
          label: "v1",
          createdAt: "2026-01-01T00:00:00Z",
          lastSeenAt: "2026-01-01T00:00:00Z",
          mapCount: 1,
          byteSize: 4096,
          rawByteSize: 4096,
          storedByteSize: 1024,
        }],
      }],
      settings: {
        retentionDays: 30,
        maxVersionsPerPage: 10,
        autoCleanup: true,
        detectionEnabled: true,
        ignoredDomains: [],
        fetchDelayMs: 300,
        fetchTimeoutMs: 30000,
        maxMapBytes: 52428800,
        sizeDisplayMode: "compressed",
      },
      totalVersions: 1,
      totalStorageBytes: 1024,
    });

    render(<DashboardApp />);
    await screen.findByText("1.00 KiB");

    expect(consoleInfo).toHaveBeenCalledWith("[SourceD] dashboard storage totals:", {
      sizeDisplayMode: "compressed",
      rawByteSize: 4096,
      storedByteSize: 1024,
      displayedByteSize: 1024,
    });
    consoleInfo.mockRestore();
  });

  it("renders domain summary text", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await screen.findByText(/1 versions/);
    expect(screen.getByText("1 versions · 3 maps · 1.00 KiB")).toBeInTheDocument();
  });

  it("renders distribution byte sizes", async () => {
    mockDashboardData({ distribution: mockDistribution });
    render(<DashboardApp />);
    await screen.findByText("5 versions · 12 maps · 100.00 KiB");
    expect(screen.getByText("5 versions · 12 maps · 100.00 KiB")).toBeInTheDocument();
    expect(screen.getByText("3 versions · 8 maps · 50.00 KiB")).toBeInTheDocument();
  });

  it("handles cleanup with no issues found", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb({ pages: mockPages, distribution: [], settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true, detectionEnabled: true, fetchDelayMs: 300, fetchTimeoutMs: 30000, maxMapBytes: 52428800 }, totalVersions: 1, totalStorageBytes: 1024 });
      } else if (msg.action === "cleanupData") {
        cb({
          ok: true,
          error: null,
          cleaned: [],
          stats: { removedVersions: 0, removedMaps: 0, reclaimedBytes: 0, remainingVersions: 1, remainingMaps: 1, remainingBytes: 1024, upgradedRefs: 0, upgradedVersions: 0 },
          steps: [{ id: "cleanup-data-tables", label: "Cleanup legacy data tables", ok: true, changed: false, summary: "Legacy data tables already clean" }],
        });
      } else {
        cb(null);
      }
    });
    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));
    const cleanBtn = screen.getByText("Optimize Storage").closest("button");
    fireEvent.click(cleanBtn);
    await waitFor(() => {
      expect(modalApi.info).toHaveBeenCalledWith(expect.objectContaining({
        title: "Storage Cleanup Checked",
        content: expect.anything(),
      }));
    });
  });

  it("handles cleanup with items cleaned", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb({ pages: [], distribution: [], settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true, detectionEnabled: true, fetchDelayMs: 300, fetchTimeoutMs: 30000, maxMapBytes: 52428800 }, totalVersions: 0, totalStorageBytes: 0 });
      } else if (msg.action === "cleanupData") {
        cb({
          ok: true,
          error: null,
          cleaned: [{ id: "v1", pageUrl: "https://example.com", reason: "all_maps_missing", mapCount: 3 }],
          stats: { removedVersions: 1, removedMaps: 3, reclaimedBytes: 1024, upgradedRefs: 8, upgradedVersions: 2 },
          steps: [
            { id: "compact-storage", label: "Compact storage data", ok: true, changed: true, summary: "Compacted storage records: 1 versions, 3 maps, 1024 bytes reclaimed, upgraded 8 refs across 2 versions" },
            { id: "cleanup-data-tables", label: "Cleanup legacy data tables", ok: true, changed: true, summary: "Removed 1 legacy data tables", removedTables: ["sourceMaps"] },
          ],
        });
      } else {
        cb(null);
      }
    });
    render(<DashboardApp />);
    await screen.findByText("No history yet.");
    const cleanBtn = screen.getByText("Optimize Storage").closest("button");
    fireEvent.click(cleanBtn);
    await waitFor(() => {
      expect(modalApi.info).toHaveBeenCalledWith(expect.objectContaining({
        title: "Storage Cleanup Completed",
        content: expect.anything(),
      }));
    });
  });

  it("handles cleanup failure", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb({ pages: [], distribution: [], settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true, detectionEnabled: true, fetchDelayMs: 300, fetchTimeoutMs: 30000, maxMapBytes: 52428800 }, totalVersions: 0, totalStorageBytes: 0 });
      } else if (msg.action === "cleanupData") {
        cb({
          ok: false,
          error: "1 cleanup steps failed",
          steps: [{ id: "cleanup-data-tables", label: "Cleanup legacy data tables", ok: false, summary: "Cleanup legacy data tables failed: cleanup exploded", error: "cleanup exploded" }],
        });
      } else {
        cb(null);
      }
    });
    render(<DashboardApp />);
    await screen.findByText("No history yet.");
    fireEvent.click(screen.getByText("Optimize Storage").closest("button"));
    await waitFor(() => {
      expect(modalApi.error).toHaveBeenCalledWith(expect.objectContaining({
        title: "Storage Cleanup Failed",
        content: expect.anything(),
      }));
    });
  });

  it("uses cleanup fallback error message when response has no error", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb({ pages: [], distribution: [], settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true, detectionEnabled: true, fetchDelayMs: 300, fetchTimeoutMs: 30000, maxMapBytes: 52428800 }, totalVersions: 0, totalStorageBytes: 0 });
      } else if (msg.action === "cleanupData") {
        cb({ ok: false, steps: [] });
      } else {
        cb(null);
      }
    });
    render(<DashboardApp />);
    await screen.findByText("No history yet.");
    fireEvent.click(screen.getByText("Optimize Storage").closest("button"));
    await waitFor(() => {
      expect(modalApi.error).toHaveBeenCalledWith(expect.objectContaining({
        title: "Storage Cleanup Failed",
        content: expect.anything(),
      }));
    });
  });

  it("uses cleaned item count when cleanup stats are missing", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb({ pages: [], distribution: [], settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true, detectionEnabled: true, fetchDelayMs: 300, fetchTimeoutMs: 30000, maxMapBytes: 52428800 }, totalVersions: 0, totalStorageBytes: 0 });
      } else if (msg.action === "cleanupData") {
        cb({
          ok: true,
          error: null,
          cleaned: [{ id: "v1", pageUrl: "https://example.com", reason: "all_maps_missing", mapCount: 2 }],
          stats: { removedVersions: 0, removedMaps: 0, reclaimedBytes: 0, remainingVersions: 0, remainingMaps: 0, remainingBytes: 0, upgradedRefs: 2, upgradedVersions: 1 },
          steps: [{ id: "compact-storage", label: "Compact storage data", ok: true, changed: true, summary: "Compacted storage records: 1 versions, 0 maps, 0 bytes reclaimed, upgraded 2 refs across 1 versions" }],
        });
      } else {
        cb(null);
      }
    });
    render(<DashboardApp />);
    await screen.findByText("No history yet.");
    fireEvent.click(screen.getByText("Optimize Storage").closest("button"));
    await waitFor(() => {
      expect(modalApi.info).toHaveBeenCalledWith(expect.objectContaining({
        title: "Storage Cleanup Completed",
        content: expect.anything(),
      }));
    });
  });

  it("renders multiple distribution legend rows", async () => {
    mockDashboardData({ distribution: mockDistribution });
    render(<DashboardApp />);
    await screen.findByText("3 versions · 8 maps · 50.00 KiB");
    expect(screen.getByText("3 versions · 8 maps · 50.00 KiB")).toBeInTheDocument();
  });

  it("CSS injection includes tree node fix", () => {
    render(<DashboardApp />);
    const styleTags = document.querySelectorAll("style");
    const matchingTag = Array.from(styleTags).find((s) => s.textContent.includes("ant-tree-node-content-wrapper"));
    expect(matchingTag).toBeTruthy();
    expect(matchingTag.textContent).toContain("nowrap");
  });

  it("renders page tabs inside each domain group", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await expandDomain();
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Example App With A Very Long Title");
    expect(screen.getByText("1 versions · 3 maps · 1.00 KiB")).toBeInTheDocument();
  });

  it("renders version count tag in domain header", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));
    // The domain header has a version count tag
    const tags = screen.getAllByText("1");
    expect(tags.length).toBeGreaterThan(0);
  });

  // ─── VersionPanel tests (expand Collapse to render) ─────────────
  it("loads version files when version collapse is expanded", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await openVersionPanel({ pageText: "Example App With A Very Long Title" });

    // VersionPanel should load files and show file count
    await screen.findByText(/1 files/, {}, { timeout: 10000 });
    // Should show action buttons
    expect(screen.getByText("Preview sources")).toBeInTheDocument();
    expect(screen.getByText("Download version")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Delete" }).length).toBeGreaterThan(0);
  }, 15000);

  it("refetches version files when sizeMode changes for the same version", async () => {
    let currentMode = "uncompressed";
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getVersionFiles") {
        cb({
          ok: true,
          files: [{
            url: "https://example.com/app.js.map",
            byteSize: currentMode === "compressed" ? 1024 : 2048,
            refCount: 1,
          }],
        });
        return;
      }
      cb({ ok: true });
    });

    const version = {
      id: "v1",
      byteSize: 2048,
    };
    const { rerender } = render(<VersionPanel version={version} sizeMode="uncompressed" />);
    await waitFor(() => {
      const fileListRequests = chrome.runtime.sendMessage.mock.calls.filter(
        ([msg]) => msg?.action === "getVersionFiles" && msg?.includeContent === false,
      );
      expect(fileListRequests).toHaveLength(1);
    });

    currentMode = "compressed";
    rerender(<VersionPanel version={{ ...version, byteSize: 1024 }} sizeMode="compressed" />);

    await waitFor(() => {
      const fileListRequests = chrome.runtime.sendMessage.mock.calls.filter(
        ([msg]) => msg?.action === "getVersionFiles" && msg?.includeContent === false,
      );
      expect(fileListRequests).toHaveLength(2);
    });
  });

  it("shows empty version files when no files returned", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024, versionFiles: [] });
    render(<DashboardApp />);
    await openVersionPanel();

    await waitFor(() => {
      expect(screen.getByText("No files in this version.")).toBeInTheDocument();
    });
  });

  it("shows shared map reference count for reused files", async () => {
    mockDashboardData({
      pages: mockPages,
      totalVersions: 1,
      totalStorageBytes: 1024,
      versionFiles: [{ url: "https://example.com/shared.js.map", content: sourceMapContent, refCount: 3 }],
    });
    render(<DashboardApp />);
    await openVersionPanel();

    await waitFor(() => {
      expect(screen.getByText("Refs ×3")).toBeInTheDocument();
    });
  });

  it("handles version download button click", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await openVersionPanel();

    // Wait for VersionPanel to load
    await waitFor(() => screen.getByText("Download version"));
    const downloadBtn = screen.getByText("Download version").closest("button");
    fireEvent.click(downloadBtn);

    await waitFor(() => {
      expect(chrome.downloads.download).toHaveBeenCalled();
    });
  });

  it("handles version download failure gracefully", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    popupSourceMapHelpers.downloadGroup.mockRejectedValueOnce(new Error("zip-fail"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<DashboardApp />);
    await openVersionPanel();

    await waitFor(() => screen.getByText("Download version"));
    fireEvent.click(screen.getByText("Download version").closest("button"));

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith("[SourceD] version download failed:", expect.any(Error));
    });
  });

  it("handles version delete button click", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await expandDomain();
    await activatePageTab();
    const versionTitle = await screen.findByText((content) => content.includes("v1.0.0-beta"));
    const versionHeaderNode = versionTitle.closest(".ant-collapse-header");
    const deleteBtn = within(versionHeaderNode).getByRole("button", { name: "Delete" });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: "deleteVersion", versionId: "v1" }),
        expect.any(Function),
      );
    });
  });

  it("handles page delete button click from page header", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await expandDomain();
    const pagePanelLabel = screen.getAllByText((content) => content.includes("Example App With A Very Long Title"))
      .find((node) => node.closest("[data-page-panel]"));
    const pagePanelNode = pagePanelLabel.closest("[data-page-panel]");
    const deleteBtn = within(pagePanelNode).getByRole("button", { name: "Delete" });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: "deletePageHistory", pageUrl: longUrl }),
        expect.any(Function),
      );
    });
  });

  it("handles site delete button click from domain header", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));

    const domainHeaderNode = screen.getByText((content) => content.includes(longSiteKey)).closest(".ant-collapse-header");
    const deleteBtn = within(domainHeaderNode).getByRole("button", { name: "Delete" });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: "deleteSiteHistory", siteKey: longSiteKey }),
        expect.any(Function),
      );
    });
  });

  it("keeps history content visible while site deletion triggers a reload", async () => {
    let hasLoadedInitialData = false;
    let pendingReload = null;
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        if (hasLoadedInitialData) {
          pendingReload = cb;
          return;
        }
        hasLoadedInitialData = true;
        cb({
          pages: mockPages,
          distribution: mockDistribution,
          settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true, detectionEnabled: true, ignoredDomains: [], fetchDelayMs: 300, fetchTimeoutMs: 30000, maxMapBytes: 52428800 },
          totalVersions: 1,
          totalStorageBytes: 1024,
        });
        return;
      }

      if (msg.action === "deleteSiteHistory") {
        cb({ ok: true });
        return;
      }

      if (msg.action === "getVersionFiles") {
        cb({ ok: true, files: mockVersionFiles });
        return;
      }

      cb({ ok: true });
    });

    render(<DashboardApp />);
    const [domainLabel] = await screen.findAllByText((content) => content.includes(longSiteKey));
    const domainHeaderNode = domainLabel.closest(".ant-collapse-header");

    fireEvent.click(within(domainHeaderNode).getByRole("button", { name: "Delete" }));

    expect(screen.getAllByText((content) => content.includes(longSiteKey)).length).toBeGreaterThan(0);
    expect(screen.queryByText("No history yet.")).not.toBeInTheDocument();
    expect(typeof pendingReload).toBe("function");

    pendingReload({
      pages: [],
      distribution: [],
      settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true, detectionEnabled: true, ignoredDomains: [], fetchDelayMs: 300, fetchTimeoutMs: 30000, maxMapBytes: 52428800 },
      totalVersions: 0,
      totalStorageBytes: 0,
    });

    await screen.findByText("No history yet.");
  });

  it("opens preview drawer when preview button is clicked", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await openVersionPanel();

    await waitFor(() => screen.getByText("Preview sources"));
    const previewBtn = screen.getByText("Preview sources").closest("button");
    fireEvent.click(previewBtn);

    // Drawer should open with source preview title
    await waitFor(() => {
      expect(screen.getByText("Source Preview")).toBeInTheDocument();
    });

    // Should show extracted source files in the tree
    await waitFor(() => {
      expect(screen.getByText((content) => content.includes("index.js"))).toBeInTheDocument();
    });
  });

  it("closes preview drawer when close button is clicked", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await openVersionPanel();

    await waitFor(() => screen.getByText("Preview sources"));
    fireEvent.click(screen.getByText("Preview sources").closest("button"));
    await waitFor(() => screen.getByText("Source Preview"));

    fireEvent.click(document.querySelector(".ant-drawer-close"));

    await waitFor(() => {
      expect(screen.queryByText("Source Preview")).not.toBeInTheDocument();
    });
  });

  it("selects a source file in preview drawer and shows code", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await openVersionPanel();

    // Open preview drawer
    await waitFor(() => screen.getByText("Preview sources"));
    fireEvent.click(screen.getByText("Preview sources").closest("button"));

    // Wait for drawer and source tree
    await waitFor(() => screen.getByText("Source Preview"));
    await waitFor(() => screen.getByText((content) => content.includes("index.js")));

    // Click on a source file in the tree to select it
    const drawer = document.querySelector(".ant-drawer-body");
    const treeNodes = drawer.querySelectorAll(".ant-tree-treenode");
    let fileTitle = null;
    for (const node of treeNodes) {
      const title = node.querySelector(".ant-tree-title");
      if (title && title.textContent.includes("index.js")) {
        fileTitle = title;
        break;
      }
    }
    expect(fileTitle).toBeTruthy();
    fireEvent.click(fileTitle);

    // Should show code preview with the file content
    await waitFor(() => {
      // The CodePreview component should render with the source content
      const codeEl = document.querySelector("pre code");
      expect(codeEl).toBeTruthy();
      expect(codeEl.textContent).toContain("console");
    });
  });

  it("renders preview code for files with unknown extension", async () => {
    const unknownMap = makeSourceMap(["README"], ["plain text content"]);
    mockDashboardData({
      pages: mockPages,
      totalVersions: 1,
      totalStorageBytes: 1024,
      versionFiles: [{ url: "https://example.com/readme.js.map", content: unknownMap }],
    });
    render(<DashboardApp />);
    await openVersionPanel();

    await waitFor(() => screen.getByText("Preview sources"));
    fireEvent.click(screen.getByText("Preview sources").closest("button"));
    await waitFor(() => screen.getByText("Source Preview"));
    await waitFor(() => screen.getByText((content) => content.includes("README")));
    fireEvent.click(screen.getByText((content) => content.includes("README")));

    await waitFor(() => {
      expect(document.querySelector("pre code").textContent).toContain("plain text content");
    });
  });

  // ─── Settings form tests ─────────────────────────────────────────
  it("saves settings when form is submitted", async () => {
    mockDashboardData({ pages: [], totalVersions: 0, totalStorageBytes: 0 });
    render(<DashboardApp />);
    await screen.findByText("No history yet.");

    // Find and click save button
    const saveBtn = screen.getByText("Save Settings").closest("button");
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: "updateSettings" }),
        expect.any(Function),
      );
    });
  });

  it("saves settings with null form values (covers || fallback)", async () => {
    mockDashboardData({ pages: [], settings: { retentionDays: null, maxVersionsPerPage: null, autoCleanup: false } });
    render(<DashboardApp />);
    await screen.findByText("No history yet.");

    // Submit form — Number(null) is 0 which is falsy, triggering || 30 and || 10 fallbacks
    const saveBtn = screen.getByText("Save Settings").closest("button");
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "updateSettings",
          settings: expect.objectContaining({ retentionDays: 30, maxVersionsPerPage: 10 }),
        }),
        expect.any(Function),
      );
    });
  });

  it("shows an error when saving settings fails", async () => {
    mockDashboardData({ pages: [], totalVersions: 0, totalStorageBytes: 0 }, {
      updateSettings: (_msg, cb) => {
        cb({ ok: false, error: "settings exploded" });
      },
    });

    render(<DashboardApp />);
    await screen.findByText("No history yet.");

    fireEvent.click(screen.getByText("Save Settings").closest("button"));

    await waitFor(() => {
      expect(messageApi.error).toHaveBeenCalledWith("settings exploded");
    });
    expect(messageApi.success).not.toHaveBeenCalled();
  });

  it("renders settings form with initial values", async () => {
    mockDashboardData({ pages: [], settings: { retentionDays: 60, maxVersionsPerPage: 20, autoCleanup: false, ignoredDomains: ["example.com"] } });
    render(<DashboardApp />);
    await screen.findByText("No history yet.");

    // Form should have the input fields
    expect(screen.getByText("Retention Days")).toBeInTheDocument();
    expect(screen.getByText("Max Versions Per Page")).toBeInTheDocument();
    expect(screen.getByText("Analysis")).toBeInTheDocument();
    expect(screen.getByText("Ignored Domains")).toBeInTheDocument();
  });

  it("saves settings including detectionEnabled and ignoredDomains when form is submitted", async () => {
    mockDashboardData({ pages: [], settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true, detectionEnabled: true, ignoredDomains: ["example.com"], fetchDelayMs: 300, fetchTimeoutMs: 30000, maxMapBytes: 52428800 }, totalVersions: 0, totalStorageBytes: 0 });
    render(<DashboardApp />);
    await screen.findByText("No history yet.");

    const ignoredDomainsInput = screen.getByLabelText("Ignored Domains");
    fireEvent.change(ignoredDomainsInput, { target: { value: "api.example.com\nexample.com\napi.example.com" } });

    const saveBtn = screen.getByText("Save Settings").closest("button");
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "updateSettings",
          settings: expect.objectContaining({
            detectionEnabled: true,
            ignoredDomains: ["api.example.com", "example.com"],
          }),
        }),
        expect.any(Function),
      );
    });
  });

  it("renders refresh button and triggers reload", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));

    const refreshBtn = screen.getByText("Refresh").closest("button");
    fireEvent.click(refreshBtn);

    // Should call getDashboardData again
    await waitFor(() => {
      const calls = chrome.runtime.sendMessage.mock.calls.filter((c) => c[0].action === "getDashboardData");
      expect(calls.length).toBeGreaterThanOrEqual(2); // initial load + refresh
    });
  });

  it("renders multiple domain groups with different pages", async () => {
    const multiPages = [
      ...mockPages,
      {
        pageUrl: "https://other-site.org/page",
        title: "Other Page",
        siteKey: "other-site.org",
        versions: [
          { id: "v2", label: "v2.0", createdAt: "2026-02-01T00:00:00Z", lastSeenAt: "2026-02-01T00:00:00Z", mapCount: 2, byteSize: 512 },
        ],
      },
    ];
    mockDashboardData({ pages: multiPages, totalVersions: 2, totalStorageBytes: 1536 });
    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));
    expect(screen.getByText((content) => content.includes("other-site.org"))).toBeInTheDocument();
  });

  // ─── Branch coverage: edge cases ─────────────────────────────────

  it("shows code preview for file with unknown extension (plain text)", async () => {
    // Source map with a .txt file (unknown language for hljs → plaintext path)
    const txtSourceMap = makeSourceMap(["data/config.txt"], ["some plain text content"]);
    mockDashboardData({
      pages: mockPages,
      totalVersions: 1,
      totalStorageBytes: 1024,
      versionFiles: [{ url: "https://example.com/bundle.js.map", content: txtSourceMap }],
    });
    render(<DashboardApp />);
    await openVersionPanel();

    // Open preview and select the txt file
    await waitFor(() => screen.getByText("Preview sources"));
    fireEvent.click(screen.getByText("Preview sources").closest("button"));
    await waitFor(() => screen.getByText("Source Preview"));
    await waitFor(() => screen.getByText((c) => c.includes("config.txt")));

    const drawer = document.querySelector(".ant-drawer-body");
    const treeNodes = drawer.querySelectorAll(".ant-tree-treenode");
    for (const node of treeNodes) {
      const title = node.querySelector(".ant-tree-title");
      if (title && title.textContent.includes("config.txt")) {
        fireEvent.click(title);
        break;
      }
    }

    await waitFor(() => {
      const codeEl = document.querySelector("pre code");
      expect(codeEl).toBeTruthy();
      expect(codeEl.textContent).toContain("some plain text content");
    });
  });

  it("handles page with no siteKey (falls back to Unknown)", async () => {
    const noSiteKeyPages = [{
      pageUrl: "https://unknown.test/page",
      title: "Unknown Site Page",
      versions: [
        { id: "v3", label: "v3", createdAt: "2026-03-01T00:00:00Z", lastSeenAt: "2026-03-01T00:00:00Z", mapCount: 1, byteSize: 100 },
      ],
    }];
    mockDashboardData({ pages: noSiteKeyPages, totalVersions: 1, totalStorageBytes: 100 });
    render(<DashboardApp />);
    await screen.findByText("Unknown");
  });

  it("handles version with null createdAt and lastSeenAt", async () => {
    const nullDatePages = [{
      pageUrl: "https://test.com",
      title: "Test Page",
      siteKey: "test.com",
      versions: [
        { id: "v4", label: "v4", createdAt: null, lastSeenAt: null, mapCount: 0, byteSize: 0 },
      ],
    }];
    mockDashboardData({ pages: nullDatePages, totalVersions: 1, totalStorageBytes: 0 });
    render(<DashboardApp />);
    await screen.findByText((c) => c.includes("test.com"));
    // Should show "Updated Unknown" for null dates
    const updatedUnknowns = screen.getAllByText(/Updated Unknown/);
    expect(updatedUnknowns.length).toBeGreaterThan(0);
  });

  it("handles page without title (falls back to URL)", async () => {
    const noTitlePages = [{
      pageUrl: "https://notitle.com/path",
      siteKey: "notitle.com",
      versions: [
        { id: "v5", label: "v5", createdAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:00:00Z", mapCount: 1, byteSize: 100 },
      ],
    }];
    mockDashboardData({ pages: noTitlePages, totalVersions: 1, totalStorageBytes: 100 });
    render(<DashboardApp />);
    // Domain header should render (page without title covered by data flow)
    await screen.findByText((c) => c.includes("notitle.com"));
  });

  it("sorts multiple pages within same domain and multiple domains", async () => {
    const multiPages = [
      {
        pageUrl: "https://alpha.com/page1",
        title: "Page 1",
        siteKey: "alpha.com",
        versions: [
          { id: "v1", label: "v1", createdAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-03T00:00:00Z", mapCount: 1, byteSize: 100 },
        ],
      },
      {
        pageUrl: "https://alpha.com/page2",
        title: "Page 2",
        siteKey: "alpha.com",
        versions: [
          { id: "v2", label: "v2", createdAt: "2026-01-02T00:00:00Z", lastSeenAt: "2026-01-01T00:00:00Z", mapCount: 1, byteSize: 200 },
        ],
      },
      {
        pageUrl: "https://beta.com/page3",
        title: "Page 3",
        siteKey: "beta.com",
        versions: [
          { id: "v3", label: "v3", createdAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-02T00:00:00Z", mapCount: 1, byteSize: 300 },
        ],
      },
    ];
    mockDashboardData({ pages: multiPages, totalVersions: 3, totalStorageBytes: 600 });
    render(<DashboardApp />);
    // Both domains should appear
    await screen.findByText((c) => c.includes("alpha.com"));
    expect(screen.getByText((c) => c.includes("beta.com"))).toBeInTheDocument();
    // Expand alpha.com domain to see pages sorted by date
    fireEvent.click(screen.getByText((c) => c.includes("alpha.com")).closest(".ant-collapse-header"));
    await waitFor(() => {
      expect(screen.getAllByText("Page 1").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Page 2").length).toBeGreaterThan(0);
    });
  });

  it("handles distribution item with zero byteSize", async () => {
    const zeroByteDist = [
      { siteKey: "zero.com", versionCount: 1, mapCount: 1, byteSize: 0 },
    ];
    mockDashboardData({ distribution: zeroByteDist });
    render(<DashboardApp />);
    await screen.findByText((c) => c.includes("zero.com"));
    // There will be multiple "0 Bytes" elements (summary + distribution)
    const zeroBytes = screen.getAllByText("0 Bytes");
    expect(zeroBytes.length).toBeGreaterThanOrEqual(1);
  });

  it("handles version with zero byteSize in panel", async () => {
    const zeroBytePage = [{
      pageUrl: "https://zero.com",
      title: "Zero Bytes Page",
      siteKey: "zero.com",
      versions: [
        { id: "v6", label: "v6", createdAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:00:00Z", mapCount: 1, byteSize: 0 },
      ],
    }];
    mockDashboardData({ pages: zeroBytePage, totalVersions: 1, totalStorageBytes: 0 });
    render(<DashboardApp />);
    await openVersionPanel({ siteKey: "zero.com", pageText: "Zero Bytes Page", versionText: "v6" });

    await waitFor(() => screen.getByText(/1 files/));
    const zeroBytes = screen.getAllByText("0 Bytes");
    expect(zeroBytes.length).toBeGreaterThanOrEqual(1);
  });

  it("handles getDashboardData returning null", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb(null);
      } else {
        cb(null);
      }
    });
    render(<DashboardApp />);
    // Should render default settings form since settings is null → default { retentionDays: 30... }
    await waitFor(() => {
      expect(screen.getByText("Retention Days")).toBeInTheDocument();
    });
  });

  it("sets zh-CN document lang for Chinese locale", () => {
    const orig = chrome.i18n.getUILanguage;
    chrome.i18n.getUILanguage = () => "zh-CN";
    render(<DashboardApp />);
    expect(document.documentElement.lang).toBe("zh-CN");
    chrome.i18n.getUILanguage = orig;
  });

  it("handles getVersionFiles returning not ok", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb({
          pages: mockPages, distribution: [], totalVersions: 1, totalStorageBytes: 1024,
          settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true, detectionEnabled: true, fetchDelayMs: 300, fetchTimeoutMs: 30000, maxMapBytes: 52428800 },
        });
      } else if (msg.action === "getVersionFiles") {
        cb({ ok: false });
      } else {
        cb(null);
      }
    });
    render(<DashboardApp />);
    await openVersionPanel();

    // Should show empty version files message
    await waitFor(() => {
      expect(screen.getByText("No files in this version.")).toBeInTheDocument();
    });
  });

  it("handles source map with deeply nested folder structure", async () => {
    const deepSourceMap = makeSourceMap(
      ["src/components/ui/Button.tsx", "src/components/ui/Input.tsx"],
      ['export const Button = () => {};', 'export const Input = () => {};'],
    );
    mockDashboardData({
      pages: mockPages,
      totalVersions: 1,
      totalStorageBytes: 1024,
      versionFiles: [{ url: "https://example.com/bundle.js.map", content: deepSourceMap }],
    });
    render(<DashboardApp />);
    await openVersionPanel();

    // Open preview
    await waitFor(() => screen.getByText("Preview sources"));
    fireEvent.click(screen.getByText("Preview sources").closest("button"));
    await waitFor(() => screen.getByText("Source Preview"));

    // Should show folder structure
    await waitFor(() => {
      expect(screen.getByText((c) => c.includes("Button.tsx"))).toBeInTheDocument();
      expect(screen.getByText((c) => c.includes("Input.tsx"))).toBeInTheDocument();
    });
  });

  it("handles zero totalVersions and totalStorageBytes fallback", async () => {
    mockDashboardData({
      pages: [],
      distribution: [],
      totalVersions: 0,
      totalStorageBytes: 0,
    });
    render(<DashboardApp />);
    // totalVersions || 0 → right side (0) evaluated since totalVersions is 0
    // totalStorageBytes || 0 → right side (0) evaluated since totalStorageBytes is 0
    await waitFor(() => {
      expect(screen.getByText("No history yet.")).toBeInTheDocument();
    });
  });

  it("handles pages with null lastSeenAt for sort comparators", async () => {
    const nullDatePages = [
      {
        pageUrl: "https://nulldate.com/page1",
        title: "Null Date Page 1",
        siteKey: "nulldate.com",
        versions: [
          { id: "v1", label: "v1", createdAt: null, lastSeenAt: null, mapCount: 1, byteSize: 100 },
        ],
      },
      {
        pageUrl: "https://nulldate.com/page2",
        title: "Null Date Page 2",
        siteKey: "nulldate.com",
        versions: [
          { id: "v2", label: "v2", createdAt: null, lastSeenAt: null, mapCount: 1, byteSize: 200 },
        ],
      },
      {
        pageUrl: "https://othersite.com/page",
        title: "Other Site",
        siteKey: "othersite.com",
        versions: [
          { id: "v3", label: "v3", createdAt: null, lastSeenAt: null, mapCount: 1, byteSize: 50 },
        ],
      },
    ];
    mockDashboardData({ pages: nullDatePages, totalVersions: 3, totalStorageBytes: 350 });
    render(<DashboardApp />);
    // Sort comparators use versions[0]?.lastSeenAt || 0 and b.lastSeenAt || 0
    // Both sides are null here, covering the || 0 fallback
    await screen.findByText((c) => c.includes("nulldate.com"));
    expect(screen.getByText((c) => c.includes("othersite.com"))).toBeInTheDocument();
  });

  it("falls back to en when getUILanguage returns empty", () => {
    const orig = chrome.i18n.getUILanguage;
    chrome.i18n.getUILanguage = () => "";
    mockDashboardData({ pages: [], distribution: [] });
    render(<DashboardApp />);
    expect(document.documentElement.lang).toBe("en");
    chrome.i18n.getUILanguage = orig;
  });

  it("handles getVersionFiles with ok but no files field", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb({
          pages: mockPages, distribution: [], totalVersions: 1, totalStorageBytes: 1024,
          settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true, detectionEnabled: true, fetchDelayMs: 300, fetchTimeoutMs: 30000, maxMapBytes: 52428800 },
        });
      } else if (msg.action === "getVersionFiles") {
        cb({ ok: true }); // no files field — triggers resp.files || [] fallback
      } else {
        cb(null);
      }
    });
    render(<DashboardApp />);
    await openVersionPanel();

    // Should show empty files but not error
    await waitFor(() => {
      expect(screen.getByText("No files in this version.")).toBeInTheDocument();
    });
  });

  it("covers folder-exists branch with multiple version files from same host", async () => {
    const sourceMap1 = makeSourceMap(["src/a.js"], ["const a = 1;"]);
    const sourceMap2 = makeSourceMap(["src/b.js"], ["const b = 2;"]);
    mockDashboardData({
      pages: mockPages,
      totalVersions: 1,
      totalStorageBytes: 2048,
      versionFiles: [
        { url: "https://example.com/bundle1.js.map", content: sourceMap1 },
        { url: "https://example.com/bundle2.js.map", content: sourceMap2 },
      ],
    });
    render(<DashboardApp />);
    await openVersionPanel();

    // Both files should render under the same host folder (folder-exists branch covered)
    await waitFor(() => screen.getByText(/2 files/));
  });

  it("deduplicates shared source files in preview drawer", async () => {
    // Two source maps that share src/shared.js
    const map1 = makeSourceMap(["src/shared.js", "src/a.js"], ["shared code", "a code"]);
    const map2 = makeSourceMap(["src/shared.js", "src/b.js"], ["shared code v2", "b code"]);
    mockDashboardData({
      pages: mockPages,
      distribution: mockDistribution,
      totalVersions: 1,
      totalStorageBytes: 2048,
      versionFiles: [
        { url: "https://example.com/a.js.map", content: map1 },
        { url: "https://example.com/b.js.map", content: map2 },
      ],
    });
    render(<DashboardApp />);
    await openVersionPanel();
    await waitFor(() => screen.getByText(/2 files/));

    // Click preview button
    const previewBtn = await screen.findByText("Preview sources");
    fireEvent.click(previewBtn);

    // In the preview drawer, shared.js should appear only once (deduped)
    await waitFor(() => {
      const sharedEntries = screen.getAllByText("shared.js");
      expect(sharedEntries).toHaveLength(1);
    });
    // a.js and b.js should each appear once
    expect(screen.getAllByText("a.js")).toHaveLength(1);
    expect(screen.getAllByText("b.js")).toHaveLength(1);
  });

  it("handles version files initial load with runtime error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 }, {
      getVersionFiles: (_msg, cb) => {
        chrome.runtime.lastError = { message: "getVersionFiles runtime error" };
        cb(null);
        chrome.runtime.lastError = null;
      },
    });
    render(<DashboardApp />);
    await openVersionPanel();

    await waitFor(() => {
      expect(screen.getByText("No files in this version.")).toBeInTheDocument();
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[SourceD] dashboard getVersionFiles failed:",
      "v1",
      expect.any(Error),
    );
  }, 15000);

  it("handles full version files load failure (ensureFullFiles !resp.ok)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 }, {
      getVersionFiles: (msg, cb) => {
        if (msg.includeContent) {
          cb({ ok: false, error: "full files load failed" });
        } else {
          cb({ ok: true, files: mockVersionFiles });
        }
      },
    });
    render(<DashboardApp />);
    await openVersionPanel();
    await screen.findByText(/1 files/);

    // Trigger full file load via preview
    const previewBtn = await screen.findByText("Preview sources");
    fireEvent.click(previewBtn);

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "[SourceD] dashboard full getVersionFiles returned error:",
        "v1",
        "full files load failed",
      );
    });
  }, 15000);

  it("uses versionFilesCache on second expand of same version panel", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    const { unmount } = render(<DashboardApp />);

    // Expand once to populate cache
    await openVersionPanel();
    await screen.findByText(/1 files/);

    // Count calls after first load
    const callsAfterFirstLoad = chrome.runtime.sendMessage.mock.calls.filter(
      ([msg]) => msg?.action === "getVersionFiles" && msg?.includeContent === false,
    ).length;
    expect(callsAfterFirstLoad).toBe(1);

    // Unmount and re-render — cache should be used on second expand
    unmount();
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);

    await openVersionPanel();
    await screen.findByText(/1 files/);

    // No additional getVersionFiles calls (served from versionFilesCache)
    const callsAfterSecondLoad = chrome.runtime.sendMessage.mock.calls.filter(
      ([msg]) => msg?.action === "getVersionFiles" && msg?.includeContent === false,
    ).length;
    expect(callsAfterSecondLoad).toBe(1);
  }, 15000);

  // ─── VersionPanel stale response cancellation test ──────────────
  it("ignores stale getVersionFiles response when version changes before callback fires", async () => {
    let resolveVersionA = null;
    let resolveVersionB = null;

    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg?.action === "getVersionFiles" && msg?.includeContent === false) {
        if (msg.versionId === "vA") {
          resolveVersionA = cb;
        } else {
          resolveVersionB = cb;
        }
        return;
      }
      cb({ ok: true });
    });

    const versionA = { id: "vA", byteSize: 1024 };
    const versionB = { id: "vB", byteSize: 2048 };

    const filesA = [{ url: "https://example.com/a.js.map" }];
    const filesB = [{ url: "https://example.com/b.js.map" }];

    const { rerender } = render(<VersionPanel version={versionA} sizeMode="uncompressed" />);

    // Switch to version B before version A response arrives
    rerender(<VersionPanel version={versionB} sizeMode="uncompressed" />);

    // Resolve version B first, then stale version A response
    resolveVersionB({ ok: true, files: filesB });
    await waitFor(() => {
      expect(screen.queryByText("No files in this version.")).not.toBeInTheDocument();
    });

    // Now fire the stale A callback — should be ignored
    resolveVersionA({ ok: true, files: filesA });

    // Final state must reflect version B (b.js.map in the tree)
    await waitFor(() => {
      expect(screen.getByText((c) => c.includes("b.js.map"))).toBeInTheDocument();
      expect(screen.queryByText((c) => c.includes("a.js.map"))).not.toBeInTheDocument();
    });
  });

  // ─── Dashboard getDashboardData runtime error test ───────────────
  it("shows error message when getDashboardData runtime message fails", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        chrome.runtime.lastError = { message: "Extension context invalidated" };
        cb(null);
        chrome.runtime.lastError = undefined;
      } else {
        cb(null);
      }
    });

    render(<DashboardApp />);

    await waitFor(() => {
      expect(messageApi.error).toHaveBeenCalledWith(
        expect.stringMatching(/failed to load|dashboard/i),
      );
    });
  });

  // ─── Dashboard delete runtime error test ────────────────────────
  it("shows error message when deleteVersion runtime message fails", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    const originalSendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "deleteVersion") {
        chrome.runtime.lastError = { message: "Delete runtime error" };
        cb(null);
        chrome.runtime.lastError = undefined;
        return;
      }
      originalSendMessage(msg, cb);
    });

    render(<DashboardApp />);
    await expandDomain();
    await activatePageTab();
    const versionTitle = await screen.findByText((content) => content.includes("v1.0.0-beta"));
    const versionHeaderNode = versionTitle.closest(".ant-collapse-header");
    const deleteBtn = within(versionHeaderNode).getByRole("button", { name: "Delete" });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(messageApi.error).toHaveBeenCalledWith("Delete runtime error");
    });
  });

  // ─── ImportMapsModal file read error test ───────────────────────
  it("shows error when file read fails during import", async () => {
    mockDashboardData({ pages: [], totalVersions: 0, totalStorageBytes: 0 });

    render(<DashboardApp />);
    fireEvent.click(screen.getByText("Import Maps").closest("button"));

    const pageUrlInput = await screen.findByLabelText("Page URL");
    fireEvent.change(pageUrlInput, { target: { value: "https://example.com/app" } });

    const file = new File(["{}"], "bad.js.map", { type: "application/json" });
    Object.defineProperty(file, "text", {
      value: vi.fn().mockRejectedValue(new Error("Read failed")),
    });

    fireEvent.change(screen.getByLabelText("Source map files"), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => {
      expect(messageApi.error).toHaveBeenCalledWith("Read failed");
    });
  }, 15000);
});
