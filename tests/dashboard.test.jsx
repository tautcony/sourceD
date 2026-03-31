import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { App as AntdApp } from "antd";
import DashboardApp from "../src/dashboard/App.jsx";
import hljs from "highlight.js/lib/core";
import * as popupSourceMapHelpers from "../src/popup/sourcemap.mjs";

const messageApi = {
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
};

vi.spyOn(AntdApp, "useApp").mockImplementation(() => ({ message: messageApi }));

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
        settings: data.settings || { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true },
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
  messageApi.success.mockReset();
  messageApi.info.mockReset();
  messageApi.error.mockReset();
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
    expect(screen.getByText("Storage Used")).toBeInTheDocument();
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

  it("renders distribution cards", async () => {
    mockDashboardData({ distribution: mockDistribution });
    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));
    expect(screen.getByText("5 versions")).toBeInTheDocument();
    expect(screen.getByText("12 maps")).toBeInTheDocument();
  });

  it("distribution cards have overflow hidden", async () => {
    mockDashboardData({ distribution: mockDistribution });
    const { container } = render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));
    // Distribution card should constrain overflow
    const distributionCards = container.querySelectorAll(".ant-card");
    const distributionSection = Array.from(distributionCards).filter((card) => {
      return card.querySelector(".ant-typography-ellipsis");
    });
    expect(distributionSection.length).toBeGreaterThan(0);
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
  });

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
  });

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

    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => {
      expect(messageApi.error).toHaveBeenCalledWith("import exploded");
    });
  });

  it("shows summary card values from data", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 5, totalStorageBytes: 1048576 });
    const { container } = render(<DashboardApp />);
    await screen.findByText("5");
    // Check storage display
    expect(screen.getByText("1.00 MB")).toBeInTheDocument();
    // Check statistic values exist in card containers
    const statValues = container.querySelectorAll(".ant-statistic-content-value-int");
    const values = Array.from(statValues).map((el) => el.textContent);
    expect(values).toContain("1"); // 1 page
    expect(values).toContain("5"); // 5 versions
  });

  it("renders domain summary text", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await screen.findByText(/1 pages/);
    expect(screen.getByText(/1 pages · 1 versions/)).toBeInTheDocument();
  });

  it("renders distribution byte sizes", async () => {
    mockDashboardData({ distribution: mockDistribution });
    render(<DashboardApp />);
    await screen.findByText("100.00 KB");
    expect(screen.getByText("100.00 KB")).toBeInTheDocument();
    expect(screen.getByText("50.00 KB")).toBeInTheDocument();
  });

  it("handles cleanup with no issues found", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb({ pages: mockPages, distribution: [], settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true }, totalVersions: 1, totalStorageBytes: 1024 });
      } else if (msg.action === "cleanupData") {
        cb({ ok: true, cleaned: [] });
      } else {
        cb(null);
      }
    });
    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));
    const cleanBtn = screen.getByText("Optimize Storage").closest("button");
    fireEvent.click(cleanBtn);
    await waitFor(() => {
      expect(messageApi.info).toHaveBeenCalledWith("No abnormal data found and no storage optimization was needed");
    });
  });

  it("handles cleanup with items cleaned", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb({ pages: [], distribution: [], settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true }, totalVersions: 0, totalStorageBytes: 0 });
      } else if (msg.action === "cleanupData") {
        cb({
          ok: true,
          cleaned: [{ id: "v1", pageUrl: "https://example.com", reason: "all_maps_missing", mapCount: 3 }],
          stats: { removedVersions: 1, removedMaps: 3, reclaimedBytes: 1024 },
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
      expect(messageApi.success).toHaveBeenCalledWith(
        expect.objectContaining({ content: "Abnormal data cleaned: 1 versions · Storage optimized: 3 maps, 1.00 KB reclaimed" }),
      );
    });
  });

  it("handles cleanup failure", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb({ pages: [], distribution: [], settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true }, totalVersions: 0, totalStorageBytes: 0 });
      } else if (msg.action === "cleanupData") {
        cb({ ok: false, error: "cleanup exploded" });
      } else {
        cb(null);
      }
    });
    render(<DashboardApp />);
    await screen.findByText("No history yet.");
    fireEvent.click(screen.getByText("Optimize Storage").closest("button"));
    await waitFor(() => {
      expect(messageApi.error).toHaveBeenCalledWith("cleanup exploded");
    });
  });

  it("uses cleanup fallback error message when response has no error", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb({ pages: [], distribution: [], settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true }, totalVersions: 0, totalStorageBytes: 0 });
      } else if (msg.action === "cleanupData") {
        cb({ ok: false });
      } else {
        cb(null);
      }
    });
    render(<DashboardApp />);
    await screen.findByText("No history yet.");
    fireEvent.click(screen.getByText("Optimize Storage").closest("button"));
    await waitFor(() => {
      expect(messageApi.error).toHaveBeenCalledWith("Cleanup failed");
    });
  });

  it("uses cleaned item count when cleanup stats are missing", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb({ pages: [], distribution: [], settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true }, totalVersions: 0, totalStorageBytes: 0 });
      } else if (msg.action === "cleanupData") {
        cb({
          ok: true,
          cleaned: [{ id: "v1", pageUrl: "https://example.com", reason: "all_maps_missing", mapCount: 2 }],
        });
      } else {
        cb(null);
      }
    });
    render(<DashboardApp />);
    await screen.findByText("No history yet.");
    fireEvent.click(screen.getByText("Optimize Storage").closest("button"));
    await waitFor(() => {
      expect(messageApi.success).toHaveBeenCalledWith(
        expect.objectContaining({ content: "Abnormal data cleaned: 1 versions · Storage optimized: 0 maps, 0 Bytes reclaimed" }),
      );
    });
  });

  it("renders multiple distribution cards", async () => {
    mockDashboardData({ distribution: mockDistribution });
    render(<DashboardApp />);
    await screen.findByText("3 versions");
    expect(screen.getByText("8 maps")).toBeInTheDocument();
  });

  it("CSS injection includes tree node fix", () => {
    render(<DashboardApp />);
    const styleTags = document.querySelectorAll("style");
    const matchingTag = Array.from(styleTags).find((s) => s.textContent.includes("ant-tree-node-content-wrapper"));
    expect(matchingTag).toBeTruthy();
    expect(matchingTag.textContent).toContain("nowrap");
  });

  it("renders page title in domain collapse header", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    // The page title appears in the nested collapse header (inside the domain group)
    await screen.findByText((content) => content.includes(longSiteKey));
    // domain header has the siteKey and summary text
    expect(screen.getByText(/1 pages · 1 versions/)).toBeInTheDocument();
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
    const domainTitle = await screen.findByText((content) => content.includes(longSiteKey), {}, { timeout: 10000 });

    // Expand domain group
    const domainHeader = domainTitle.closest(".ant-collapse-header");
    fireEvent.click(domainHeader);

    // Expand page panel
    const pageTitle = await screen.findByText((content) => content.includes("Example App With A Very Long Title"), {}, { timeout: 10000 });
    const pageHeader = pageTitle.closest(".ant-collapse-header");
    fireEvent.click(pageHeader);

    // Expand version panel
    const versionTitle = await screen.findByText((content) => content.includes("v1.0.0-beta"), {}, { timeout: 10000 });
    const versionHeader = versionTitle.closest(".ant-collapse-header");
    fireEvent.click(versionHeader);

    // VersionPanel should load files and show file count
    await screen.findByText(/1 files/, {}, { timeout: 10000 });
    // Should show action buttons
    expect(screen.getByText("Preview Sources")).toBeInTheDocument();
    expect(screen.getByText("Download version")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Delete" }).length).toBeGreaterThan(0);
  }, 15000);

  it("shows empty version files when no files returned", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024, versionFiles: [] });
    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));

    // Expand all collapses
    fireEvent.click(screen.getByText((content) => content.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("Example App")));
    fireEvent.click(screen.getByText((content) => content.includes("Example App")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("v1.0.0-beta")));
    fireEvent.click(screen.getByText((content) => content.includes("v1.0.0-beta")).closest(".ant-collapse-header"));

    await waitFor(() => {
      expect(screen.getByText("No files in this version.")).toBeInTheDocument();
    });
  });

  it("handles version download button click", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));

    // Expand all panels
    fireEvent.click(screen.getByText((content) => content.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("Example App")));
    fireEvent.click(screen.getByText((content) => content.includes("Example App")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("v1.0.0-beta")));
    fireEvent.click(screen.getByText((content) => content.includes("v1.0.0-beta")).closest(".ant-collapse-header"));

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
    vi.spyOn(popupSourceMapHelpers, "downloadGroup").mockRejectedValueOnce(new Error("zip-fail"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));
    fireEvent.click(screen.getByText((content) => content.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("Example App")));
    fireEvent.click(screen.getByText((content) => content.includes("Example App")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("v1.0.0-beta")));
    fireEvent.click(screen.getByText((content) => content.includes("v1.0.0-beta")).closest(".ant-collapse-header"));

    await waitFor(() => screen.getByText("Download version"));
    fireEvent.click(screen.getByText("Download version").closest("button"));

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith("[SourceD] version download failed:", expect.any(Error));
    });
  });

  it("handles version delete button click", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));

    // Expand only the levels required to render the version header.
    fireEvent.click(screen.getByText((content) => content.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("Example App")));
    fireEvent.click(screen.getByText((content) => content.includes("Example App")).closest(".ant-collapse-header"));
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
    await screen.findByText((content) => content.includes(longSiteKey));

    fireEvent.click(screen.getByText((content) => content.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("Example App With A Very Long Title")));

    const pageHeaderNode = screen.getByText((content) => content.includes("Example App With A Very Long Title")).closest(".ant-collapse-header");
    const deleteBtn = within(pageHeaderNode).getByRole("button", { name: "Delete" });
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

  it("opens preview drawer when preview button is clicked", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));

    // Expand all panels
    fireEvent.click(screen.getByText((content) => content.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("Example App")));
    fireEvent.click(screen.getByText((content) => content.includes("Example App")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("v1.0.0-beta")));
    fireEvent.click(screen.getByText((content) => content.includes("v1.0.0-beta")).closest(".ant-collapse-header"));

    await waitFor(() => screen.getByText("Preview Sources"));
    const previewBtn = screen.getByText("Preview Sources").closest("button");
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
    await screen.findByText((content) => content.includes(longSiteKey));

    fireEvent.click(screen.getByText((content) => content.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("Example App")));
    fireEvent.click(screen.getByText((content) => content.includes("Example App")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("v1.0.0-beta")));
    fireEvent.click(screen.getByText((content) => content.includes("v1.0.0-beta")).closest(".ant-collapse-header"));

    await waitFor(() => screen.getByText("Preview Sources"));
    fireEvent.click(screen.getByText("Preview Sources").closest("button"));
    await waitFor(() => screen.getByText("Source Preview"));

    fireEvent.click(document.querySelector(".ant-drawer-close"));

    await waitFor(() => {
      expect(screen.queryByText("Source Preview")).not.toBeInTheDocument();
    });
  });

  it("selects a source file in preview drawer and shows code", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));

    // Expand all panels to reach VersionPanel
    fireEvent.click(screen.getByText((content) => content.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("Example App")));
    fireEvent.click(screen.getByText((content) => content.includes("Example App")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("v1.0.0-beta")));
    fireEvent.click(screen.getByText((content) => content.includes("v1.0.0-beta")).closest(".ant-collapse-header"));

    // Open preview drawer
    await waitFor(() => screen.getByText("Preview Sources"));
    fireEvent.click(screen.getByText("Preview Sources").closest("button"));

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
    await screen.findByText((content) => content.includes(longSiteKey));

    fireEvent.click(screen.getByText((content) => content.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("Example App")));
    fireEvent.click(screen.getByText((content) => content.includes("Example App")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("v1.0.0-beta")));
    fireEvent.click(screen.getByText((content) => content.includes("v1.0.0-beta")).closest(".ant-collapse-header"));

    await waitFor(() => screen.getByText("Preview Sources"));
    fireEvent.click(screen.getByText("Preview Sources").closest("button"));
    await waitFor(() => screen.getByText("Source Preview"));
    await waitFor(() => screen.getByText((content) => content.includes("README")));
    fireEvent.click(screen.getByText((content) => content.includes("README")));

    await waitFor(() => {
      expect(document.querySelector("pre code").textContent).toContain("plain text content");
    });
  });

  it("falls back to plain text preview when syntax highlight throws", async () => {
    mockDashboardData({ pages: mockPages, totalVersions: 1, totalStorageBytes: 1024 });
    vi.spyOn(hljs, "highlight").mockImplementation(() => {
      throw new Error("highlight-fail");
    });

    render(<DashboardApp />);
    await screen.findByText((content) => content.includes(longSiteKey));

    fireEvent.click(screen.getByText((content) => content.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("Example App")));
    fireEvent.click(screen.getByText((content) => content.includes("Example App")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((content) => content.includes("v1.0.0-beta")));
    fireEvent.click(screen.getByText((content) => content.includes("v1.0.0-beta")).closest(".ant-collapse-header"));

    await waitFor(() => screen.getByText("Preview Sources"));
    fireEvent.click(screen.getByText("Preview Sources").closest("button"));
    await waitFor(() => screen.getByText("Source Preview"));
    await waitFor(() => screen.getByText((content) => content.includes("index.js")));
    fireEvent.click(screen.getByText((content) => content.includes("index.js")));

    await waitFor(() => {
      expect(document.querySelector("pre code").textContent).toContain("console.log");
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
    mockDashboardData({ pages: [], settings: { retentionDays: 60, maxVersionsPerPage: 20, autoCleanup: false } });
    render(<DashboardApp />);
    await screen.findByText("No history yet.");

    // Form should have the input fields
    expect(screen.getByText("Retention Days")).toBeInTheDocument();
    expect(screen.getByText("Max Versions Per Page")).toBeInTheDocument();
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
    await screen.findByText((c) => c.includes(longSiteKey));

    // Expand all panels
    fireEvent.click(screen.getByText((c) => c.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((c) => c.includes("Example App")));
    fireEvent.click(screen.getByText((c) => c.includes("Example App")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((c) => c.includes("v1.0.0-beta")));
    fireEvent.click(screen.getByText((c) => c.includes("v1.0.0-beta")).closest(".ant-collapse-header"));

    // Open preview and select the txt file
    await waitFor(() => screen.getByText("Preview Sources"));
    fireEvent.click(screen.getByText("Preview Sources").closest("button"));
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
      expect(screen.getByText("Page 1")).toBeInTheDocument();
      expect(screen.getByText("Page 2")).toBeInTheDocument();
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
    await screen.findByText((c) => c.includes("zero.com"));

    // Expand all
    fireEvent.click(screen.getByText((c) => c.includes("zero.com")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((c) => c.includes("Zero Bytes Page")));
    fireEvent.click(screen.getByText((c) => c.includes("Zero Bytes Page")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((c) => c.includes("v6")));
    fireEvent.click(screen.getByText((c) => c.includes("v6")).closest(".ant-collapse-header"));

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
          settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true },
        });
      } else if (msg.action === "getVersionFiles") {
        cb({ ok: false });
      } else {
        cb(null);
      }
    });
    render(<DashboardApp />);
    await screen.findByText((c) => c.includes(longSiteKey));

    // Expand all to reach version
    fireEvent.click(screen.getByText((c) => c.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((c) => c.includes("Example App")));
    fireEvent.click(screen.getByText((c) => c.includes("Example App")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((c) => c.includes("v1.0.0-beta")));
    fireEvent.click(screen.getByText((c) => c.includes("v1.0.0-beta")).closest(".ant-collapse-header"));

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
    await screen.findByText((c) => c.includes(longSiteKey));

    // Expand all
    fireEvent.click(screen.getByText((c) => c.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((c) => c.includes("Example App")));
    fireEvent.click(screen.getByText((c) => c.includes("Example App")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((c) => c.includes("v1.0.0-beta")));
    fireEvent.click(screen.getByText((c) => c.includes("v1.0.0-beta")).closest(".ant-collapse-header"));

    // Open preview
    await waitFor(() => screen.getByText("Preview Sources"));
    fireEvent.click(screen.getByText("Preview Sources").closest("button"));
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
          settings: { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true },
        });
      } else if (msg.action === "getVersionFiles") {
        cb({ ok: true }); // no files field — triggers resp.files || [] fallback
      } else {
        cb(null);
      }
    });
    render(<DashboardApp />);
    await screen.findByText((c) => c.includes(longSiteKey));

    // Expand to reach version
    fireEvent.click(screen.getByText((c) => c.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((c) => c.includes("Example App")));
    fireEvent.click(screen.getByText((c) => c.includes("Example App")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((c) => c.includes("v1.0.0-beta")));
    fireEvent.click(screen.getByText((c) => c.includes("v1.0.0-beta")).closest(".ant-collapse-header"));

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
    await screen.findByText((c) => c.includes(longSiteKey));

    // Expand all
    fireEvent.click(screen.getByText((c) => c.includes(longSiteKey)).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((c) => c.includes("Example App")));
    fireEvent.click(screen.getByText((c) => c.includes("Example App")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((c) => c.includes("v1.0.0-beta")));
    fireEvent.click(screen.getByText((c) => c.includes("v1.0.0-beta")).closest(".ant-collapse-header"));

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
    const siteKeyTexts = await screen.findAllByText((c) => c.includes(longSiteKey));

    // Expand to version panel - click the first match (history collapse, not distribution card)
    fireEvent.click(siteKeyTexts[0].closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((c) => c.includes("Example App")));
    fireEvent.click(screen.getByText((c) => c.includes("Example App")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText((c) => c.includes("v1.0.0-beta")));
    fireEvent.click(screen.getByText((c) => c.includes("v1.0.0-beta")).closest(".ant-collapse-header"));
    await waitFor(() => screen.getByText(/2 files/));

    // Click preview button
    const previewBtn = await screen.findByText("Preview Sources");
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
});
