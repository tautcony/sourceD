import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import PopupApp from "../src/popup/App.jsx";

// Mock FileReader for download tests
class MockFileReader {
  readAsDataURL() {
    setTimeout(() => {
      this.result = "data:application/zip;base64,AAAA";
      if (this.onloadend) this.onloadend();
    }, 0);
  }
}

// Helper to make a minimal source map
function makeSourceMap(sources, sourcesContent) {
  return JSON.stringify({
    version: 3, file: "bundle.js", sources, sourcesContent, mappings: "AAAA", names: [],
  });
}

function mockPopupState(data) {
  chrome.tabs.query = vi.fn((_, cb) => cb([{ id: 1, url: data.pageUrl || "https://example.com/app" }]));
  chrome.runtime.sendMessage = vi.fn((msg, cb) => {
    if (msg.action === "getPopupState") {
      cb({
        ok: true,
        pageUrl: data.pageUrl || "https://example.com/app",
        latestVersion: data.latestVersion || null,
        files: data.files || [],
        totalStorageBytes: data.totalStorageBytes || 0,
        totalVersions: data.totalVersions || 0,
      });
    } else if (msg.action === "deletePageHistory") {
      if (cb) cb({ ok: true });
    } else {
      if (cb) cb(null);
    }
  });
}

beforeEach(() => {
  globalThis.FileReader = MockFileReader;
  chrome.downloads.download = vi.fn((opts, cb) => { if (cb) cb(1); });
});

describe("PopupApp", () => {
  afterEach(() => {
    chrome.tabs.query = vi.fn((_, cb) => cb([{ id: 1, url: "https://test.com" }]));
    chrome.runtime.sendMessage = vi.fn((msg, cb) => { if (cb) cb(null); });
  });

  it("renders header title", async () => {
    render(<PopupApp />);
    expect(screen.getByText("SourceD")).toBeInTheDocument();
  });

  it("renders history button", () => {
    render(<PopupApp />);
    expect(screen.getByText("History")).toBeInTheDocument();
  });

  it("renders clear button (disabled when no version)", () => {
    render(<PopupApp />);
    const clearBtn = screen.getByText("Clear Current Page").closest("button");
    expect(clearBtn).toBeDisabled();
  });

  it("shows empty state when no source maps", async () => {
    render(<PopupApp />);
    await screen.findByText("No source files detected");
    expect(screen.getByText("No source files detected")).toBeInTheDocument();
  });

  it("shows stats text", async () => {
    render(<PopupApp />);
    await screen.findByText(/versions/);
    expect(screen.getByText(/versions/)).toBeInTheDocument();
  });

  it("renders file tree when version data is available", async () => {
    const sourceMap = makeSourceMap(["src/index.js"], ['console.log("hi");']);
    mockPopupState({
      pageUrl: "https://example.com/app",
      latestVersion: { id: "v1", label: "v1 · 01/15, 10:30 AM", createdAt: "2026-01-15T10:30:00Z", mapCount: 1, byteSize: 500 },
      files: [{ url: "https://example.com/bundle.js.map", content: sourceMap }],
      totalVersions: 3,
      totalStorageBytes: 2048,
    });
    render(<PopupApp />);
    await screen.findByText("Download all");
    expect(screen.getByText("Download all")).toBeInTheDocument();
    // Stats should show updated values
    expect(screen.getByText(/3 versions/)).toBeInTheDocument();
  });

  it("enables clear button when version exists", async () => {
    mockPopupState({
      latestVersion: { id: "v1", label: "v1", createdAt: "2026-01-01T00:00:00Z", mapCount: 1, byteSize: 100 },
      files: [{ url: "test.map", content: makeSourceMap(["a.js"], ["var a;"]) }],
    });
    render(<PopupApp />);
    await screen.findByText("Download all");
    const clearBtn = screen.getByText("Clear Current Page").closest("button");
    expect(clearBtn).not.toBeDisabled();
  });

  it("shows latest version label", async () => {
    mockPopupState({
      latestVersion: { id: "v1", label: "v2 · 01/15, 10:30 AM", createdAt: "2026-01-15T10:30:00Z", mapCount: 1, byteSize: 500 },
      files: [{ url: "bundle.map", content: makeSourceMap(["x.js"], ["var x;"]) }],
    });
    render(<PopupApp />);
    await screen.findByText(/Latest version/);
    expect(screen.getByText(/v2 · 01\/15/)).toBeInTheDocument();
  });

  it("clicking history button opens dashboard", async () => {
    chrome.tabs.create = vi.fn();
    render(<PopupApp />);
    const historyBtn = screen.getByText("History").closest("button");
    fireEvent.click(historyBtn);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "chrome-extension://fakeid/dashboard.html" });
  });

  it("clicking clear button triggers deletePageHistory", async () => {
    mockPopupState({
      latestVersion: { id: "v1", label: "v1", createdAt: "2026-01-01T00:00:00Z", mapCount: 1, byteSize: 100 },
      files: [{ url: "test.map", content: makeSourceMap(["a.js"], ["var a;"]) }],
    });
    render(<PopupApp />);
    await screen.findByText("Download all");
    const clearBtn = screen.getByText("Clear Current Page").closest("button");
    fireEvent.click(clearBtn);
    await waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: "deletePageHistory" }),
        expect.any(Function),
      );
    });
  });

  it("clicking Download all triggers downloadGroup", async () => {
    const sourceMap = makeSourceMap(["src/app.js"], ['const app = "hello";']);
    mockPopupState({
      latestVersion: { id: "v1", label: "v1", createdAt: "2026-01-01T00:00:00Z", mapCount: 1, byteSize: 500 },
      files: [{ url: "https://example.com/app.js.map", content: sourceMap }],
    });
    render(<PopupApp />);
    await screen.findByText("Download all");
    const downloadBtn = screen.getByText("Download all").closest("button");
    fireEvent.click(downloadBtn);
    await waitFor(() => {
      expect(chrome.downloads.download).toHaveBeenCalled();
    });
  });

  it("clicking a tree file node triggers single file download", async () => {
    const sourceMap = makeSourceMap(["src/index.js"], ['console.log("hi");']);
    mockPopupState({
      latestVersion: { id: "v1", label: "v1", createdAt: "2026-01-01T00:00:00Z", mapCount: 1, byteSize: 500 },
      files: [{ url: "https://example.com/bundle.js.map", content: sourceMap }],
    });
    render(<PopupApp />);
    await screen.findByText("Download all");
    // Find a leaf node (file node) and click it
    const leafNodes = document.querySelectorAll(".ant-tree-treenode");
    let fileNode = null;
    for (const node of leafNodes) {
      const title = node.querySelector(".ant-tree-title");
      if (title && title.textContent.includes("bundle.js.map")) {
        fileNode = title;
        break;
      }
    }
    if (fileNode) {
      fireEvent.click(fileNode);
      await waitFor(() => {
        expect(chrome.downloads.download).toHaveBeenCalled();
      });
    }
  });

  it("clicking a folder node does nothing (early return)", async () => {
    const sourceMap = makeSourceMap(["src/index.js"], ['console.log("hi");']);
    mockPopupState({
      latestVersion: { id: "v1", label: "v1", createdAt: "2026-01-01T00:00:00Z", mapCount: 1, byteSize: 500 },
      files: [{ url: "https://example.com/bundle.js.map", content: sourceMap }],
    });
    render(<PopupApp />);
    await screen.findByText("Download all");
    // Click on a folder node (key starts with "folder-")
    const treeNodes = document.querySelectorAll(".ant-tree-treenode");
    for (const node of treeNodes) {
      const switcher = node.querySelector(".ant-tree-switcher");
      if (switcher && !node.classList.contains("ant-tree-treenode-leaf-last")) {
        const title = node.querySelector(".ant-tree-title");
        if (title) {
          chrome.downloads.download = vi.fn();
          fireEvent.click(title);
          // Should NOT trigger a download
          expect(chrome.downloads.download).not.toHaveBeenCalled();
          break;
        }
      }
    }
  });

  it("handles multiple files from same host (folder already exists)", async () => {
    const sourceMap1 = makeSourceMap(["src/a.js"], ["const a = 1;"]);
    const sourceMap2 = makeSourceMap(["src/b.js"], ["const b = 2;"]);
    mockPopupState({
      latestVersion: { id: "v1", label: "v1", createdAt: "2026-01-01T00:00:00Z", mapCount: 2, byteSize: 1000 },
      files: [
        { url: "https://example.com/a.js.map", content: sourceMap1 },
        { url: "https://example.com/b.js.map", content: sourceMap2 },
      ],
    });
    render(<PopupApp />);
    await screen.findByText("Download all");
    // Both files should render under the same host folder
    const treeNodes = document.querySelectorAll(".ant-tree-treenode");
    expect(treeNodes.length).toBeGreaterThanOrEqual(3); // at least host folder + 2 files
  });

  it("handles tab with no URL", async () => {
    chrome.tabs.query = vi.fn((_, cb) => cb([{ id: 1 }]));
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getPopupState") {
        cb({ ok: true, latestVersion: null, files: [], totalStorageBytes: 0, totalVersions: 0 });
      } else {
        if (cb) cb(null);
      }
    });
    render(<PopupApp />);
    await screen.findByText("No source files detected");
    expect(screen.getByText("No source files detected")).toBeInTheDocument();
  });

  it("handles getPopupState returning not ok", async () => {
    chrome.tabs.query = vi.fn((_, cb) => cb([{ id: 1, url: "https://example.com" }]));
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getPopupState") {
        cb({ ok: false });
      } else {
        if (cb) cb(null);
      }
    });
    render(<PopupApp />);
    await screen.findByText("No source files detected");
  });

  it("handles zero totalStorageBytes and zero totalVersions", async () => {
    const sourceMap = makeSourceMap(["src/index.js"], ['console.log("hi");']);
    mockPopupState({
      latestVersion: { id: "v1", label: "v1", createdAt: "2026-01-01T00:00:00Z", mapCount: 1, byteSize: 0 },
      files: [{ url: "https://example.com/bundle.js.map", content: sourceMap }],
      totalStorageBytes: 0,
      totalVersions: 0,
    });
    render(<PopupApp />);
    await screen.findByText("Download all");
    // Should show 0 storage values
    const zeroBytes = screen.getAllByText(/0 Bytes/);
    expect(zeroBytes.length).toBeGreaterThanOrEqual(1);
  });

  it("handles getPopupState with ok but no files field", async () => {
    chrome.tabs.query = vi.fn((_, cb) => cb([{ id: 1, url: "https://example.com" }]));
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getPopupState") {
        cb({ ok: true, latestVersion: null, totalStorageBytes: 0, totalVersions: 0 });
        // no files field → data.files is undefined → || [] fallback
      } else {
        if (cb) cb(null);
      }
    });
    render(<PopupApp />);
    await screen.findByText("No source files detected");
  });
});
