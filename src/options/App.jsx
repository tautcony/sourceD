import { useState, useEffect, useCallback } from "react";
import {
  Button, Typography, Card, Statistic, Flex, ConfigProvider,
} from "antd";
import { DashboardOutlined } from "@ant-design/icons";
import { i18nMessage } from "../shared/utils.mjs";

const { Title, Text, Paragraph } = Typography;

export default function OptionsApp() {
  const manifest = chrome.runtime.getManifest();
  const [mapCount, setMapCount] = useState("-");
  const [pageCount, setPageCount] = useState("-");

  useEffect(() => {
    const locale = chrome.i18n.getUILanguage() || "en";
    document.documentElement.lang = /^zh\b/i.test(locale) ? "zh-CN" : "en";
    document.title = i18nMessage("optionsPageTitle");

    chrome.runtime.sendMessage({ action: "getDashboardData" }, (data) => {
      if (!data) return;
      setMapCount(String(data.totalVersions || 0));
      setPageCount(String((data.pages || []).length));
    });
  }, []);

  const handleOpenDashboard = useCallback(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  }, []);

  const permissions = [
    i18nMessage("optionsPermissionWebRequest"),
    i18nMessage("optionsPermissionDownloads"),
    i18nMessage("optionsPermissionTabs"),
    i18nMessage("optionsPermissionStorage"),
    i18nMessage("optionsPermissionHosts"),
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
            <span dangerouslySetInnerHTML={{ __html: i18nMessage("optionsWhatItDoesBody") }} />
          </Paragraph>
        </Card>

        {/* Permissions */}
        <Card title={i18nMessage("optionsPermissionsTitle")} size="small">
          <ul style={{ listStyle: "disc", paddingLeft: 20 }}>
            {permissions.map((item, i) => (
              <li key={i} style={{ marginBottom: 8 }}>
                <span dangerouslySetInnerHTML={{ __html: item }} />
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
