import { useState, useEffect, useCallback } from "react";
import {
  Button, Typography, Card, Statistic, Flex, ConfigProvider,
} from "antd";
import { DashboardOutlined } from "@ant-design/icons";
import { i18nMessage, setI18nLocale, uiLocale } from "../shared/utils.mjs";
import enMessages from "../../_locales/en/messages.json";
import zhCNMessages from "../../_locales/zh_CN/messages.json";

const { Title, Text, Paragraph } = Typography;

export default function OptionsApp() {
  const manifest = chrome.runtime.getManifest();
  const [mapCount, setMapCount] = useState("-");
  const [pageCount, setPageCount] = useState("-");
  const [setLocale] = useState("en-US");

  useEffect(() => {
    const browserLang = chrome.i18n.getUILanguage() || "en";
    const isZh = /^zh\b/i.test(browserLang);
    document.documentElement.lang = isZh ? "zh-CN" : "en";
    setI18nLocale(isZh ? zhCNMessages : enMessages);
    document.title = i18nMessage("optionsPageTitle");

    chrome.runtime.sendMessage({ action: "getDashboardData" }, (data) => {
      if (!data) return;
      setMapCount(String(data.totalVersions || 0));
      setPageCount(String((data.pages || []).length));
      if (data.settings?.uiLanguage) {
        const effectiveLang = uiLocale(data.settings);
        const useZh = effectiveLang === "zh-CN";
        document.documentElement.lang = useZh ? "zh-CN" : "en";
        setI18nLocale(useZh ? zhCNMessages : enMessages);
        document.title = i18nMessage("optionsPageTitle");
        setLocale(effectiveLang);
      }
    });
  }, [setLocale]);

  const handleOpenDashboard = useCallback(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  }, []);

  const permissions = [
    { code: "webRequest", bodyKey: "optionsPermissionWebRequestBody" },
    { code: "downloads", bodyKey: "optionsPermissionDownloadsBody" },
    { code: "tabs", bodyKey: "optionsPermissionTabsBody" },
    { code: "storage", bodyKey: "optionsPermissionStorageBody" },
    { code: "<all_urls>", bodyKey: "optionsPermissionHostsBody" },
  ];

  const privacyItems = [
    i18nMessage("optionsPrivacyLocal"),
    i18nMessage("optionsPrivacyNoRemote"),
    i18nMessage("optionsPrivacyClear"),
  ];

  return (
    <ConfigProvider theme={{ token: { fontSize: 13 } }}>
      <Flex vertical gap={24} style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
        {/* Hero */}
        <Flex vertical gap={8}>
          <Text type="secondary">{i18nMessage("optionsEyebrow")}</Text>
          <Title level={2} style={{ margin: 0 }}>SourceD</Title>
          <Text type="secondary">{i18nMessage("optionsLead")}</Text>

          <Flex gap={16} style={{ marginTop: 12 }}>
            <Card size="small" style={{ flex: 1 }}>
              <Statistic title={i18nMessage("optionsVersion")} value={manifest.version || "unknown"} />
            </Card>
            <Card size="small" style={{ flex: 1 }}>
              <Statistic title={i18nMessage("optionsCachedMaps")} value={mapCount} />
            </Card>
            <Card size="small" style={{ flex: 1 }}>
              <Statistic title={i18nMessage("optionsTrackedPages")} value={pageCount} />
            </Card>
          </Flex>

          <div style={{ marginTop: 8 }}>
            <Button icon={<DashboardOutlined />} onClick={handleOpenDashboard}>
              {i18nMessage("optionsOpenDashboard")}
            </Button>
          </div>
        </Flex>

        {/* What It Does */}
        <Card title={i18nMessage("optionsWhatItDoesTitle")} size="small">
          <Paragraph>
            {i18nMessage("optionsWhatItDoesBodyPrefix")}
            {" "}
            <code>sourceMappingURL</code>
            {" "}
            {i18nMessage("optionsWhatItDoesBodyMiddle")}
            {" "}
            <code>sourcesContent</code>
            {" "}
            {i18nMessage("optionsWhatItDoesBodySuffix")}
          </Paragraph>
        </Card>

        {/* Permissions */}
        <Card title={i18nMessage("optionsPermissionsTitle")} size="small">
          <ul style={{ listStyle: "disc", paddingLeft: 20 }}>
            {permissions.map((item, i) => (
              <li key={i} style={{ marginBottom: 8 }}>
                <code>{item.code}</code>
                {" "}
                {i18nMessage(item.bodyKey)}
              </li>
            ))}
          </ul>
        </Card>

        {/* Privacy */}
        <Card title={i18nMessage("optionsPrivacyTitle")} size="small">
          <ul style={{ listStyle: "disc", paddingLeft: 20 }}>
            {privacyItems.map((item, i) => (
              <li key={i} style={{ marginBottom: 8 }}>{item}</li>
            ))}
          </ul>
        </Card>

        {/* Responsible Use */}
        <Card title={i18nMessage("optionsResponsibleTitle")} size="small">
          <Paragraph>{i18nMessage("optionsResponsibleBody")}</Paragraph>
        </Card>

        {/* History Dashboard */}
        <Card title={i18nMessage("optionsHistoryTitle")} size="small">
          <Paragraph>{i18nMessage("optionsHistoryBody")}</Paragraph>
        </Card>
      </Flex>
    </ConfigProvider>
  );
}
