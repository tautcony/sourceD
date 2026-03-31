import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import OptionsApp from "../src/options/App.jsx";

describe("OptionsApp", () => {
  afterEach(() => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => { if (cb) cb(null); });
  });

  it("renders app name", () => {
    render(<OptionsApp />);
    expect(screen.getByText("SourceD")).toBeInTheDocument();
  });

  it("renders eyebrow text", () => {
    render(<OptionsApp />);
    expect(screen.getByText("Browser Extension")).toBeInTheDocument();
  });

  it("renders version statistic", () => {
    render(<OptionsApp />);
    expect(screen.getByText("Version")).toBeInTheDocument();
    expect(screen.getByText("0.0.1")).toBeInTheDocument();
  });

  it("renders section cards", () => {
    render(<OptionsApp />);
    expect(screen.getByText("What It Does")).toBeInTheDocument();
    expect(screen.getByText("Permissions")).toBeInTheDocument();
    expect(screen.getByText("Privacy")).toBeInTheDocument();
    expect(screen.getByText("Responsible Use")).toBeInTheDocument();
    expect(screen.getByText("History Dashboard")).toBeInTheDocument();
  });

  it("renders dashboard button", () => {
    render(<OptionsApp />);
    expect(screen.getByText("Open History Dashboard")).toBeInTheDocument();
  });

  it("renders privacy items", () => {
    render(<OptionsApp />);
    expect(screen.getByText("Processing happens locally")).toBeInTheDocument();
    expect(screen.getByText("No collected map data is sent")).toBeInTheDocument();
  });

  it("loads dashboard data and shows counts", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb({ totalVersions: 42, pages: [{ url: "a" }, { url: "b" }] });
      } else {
        cb(null);
      }
    });
    render(<OptionsApp />);
    await waitFor(() => {
      expect(screen.getByText("42")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
    });
  });

  it("clicking dashboard button opens dashboard tab", () => {
    chrome.tabs.create = vi.fn();
    render(<OptionsApp />);
    const dashBtn = screen.getByText("Open History Dashboard").closest("button");
    fireEvent.click(dashBtn);
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "chrome-extension://fakeid/dashboard.html",
    });
  });

  it("handles getDashboardData returning null", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb(null);
      } else {
        cb(null);
      }
    });
    render(<OptionsApp />);
    // Should still show default dash values (-)
    const dashes = screen.getAllByText("-");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it("handles data with no pages key", async () => {
    chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      if (msg.action === "getDashboardData") {
        cb({ totalVersions: 0 });
      } else {
        cb(null);
      }
    });
    render(<OptionsApp />);
    await waitFor(() => {
      const zeros = screen.getAllByText("0");
      expect(zeros.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("handles manifest with no version", async () => {
    const orig = chrome.runtime.getManifest;
    chrome.runtime.getManifest = () => ({ name: "SourceD" });
    render(<OptionsApp />);
    expect(screen.getByText("unknown")).toBeInTheDocument();
    chrome.runtime.getManifest = orig;
  });

  it("sets zh-CN language for Chinese locale", () => {
    const orig = chrome.i18n.getUILanguage;
    chrome.i18n.getUILanguage = () => "zh-CN";
    render(<OptionsApp />);
    expect(document.documentElement.lang).toBe("zh-CN");
    chrome.i18n.getUILanguage = orig;
  });

  it("falls back to en when getUILanguage returns empty", () => {
    const orig = chrome.i18n.getUILanguage;
    chrome.i18n.getUILanguage = () => "";
    render(<OptionsApp />);
    expect(document.documentElement.lang).toBe("en");
    chrome.i18n.getUILanguage = orig;
  });
});
