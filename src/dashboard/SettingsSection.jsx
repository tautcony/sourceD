import { useState, useEffect, useCallback } from "react";
import { App, Button, Card, Col, Divider, Flex, Form, Input, InputNumber, Row, Select, Switch, Typography } from "antd";
import { fileSizeIEC, i18nMessage, normalizeDomainFilterList } from "../shared/utils.mjs";
import { runtimeMessageError } from "../shared/runtime-utils.js";

const { Text } = Typography;

export default function SettingsSection({ settings, onReload }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();
  const maxMapBytesValue = Form.useWatch("maxMapBytes", form);

  useEffect(() => {
    if (settings) {
      form.setFieldsValue({
        retentionDays: settings.retentionDays,
        maxVersionsPerPage: settings.maxVersionsPerPage,
        autoCleanup: !!settings.autoCleanup,
        detectionEnabled: settings.detectionEnabled !== false,
        ignoredDomains: (settings.ignoredDomains || []).join("\n"),
        sizeDisplayMode: settings.sizeDisplayMode || "uncompressed",
        fetchDelayMs: settings.fetchDelayMs,
        fetchTimeoutMs: settings.fetchTimeoutMs,
        fetchConcurrency: settings.fetchConcurrency,
        maxMapBytes: settings.maxMapBytes,
        uiLanguage: settings.uiLanguage || "auto",
      });
    }
  }, [settings, form]);

  const handleSave = useCallback((values) => {
    setSaving(true);
    chrome.runtime.sendMessage({
      action: "updateSettings",
      settings: {
        retentionDays: Number(values.retentionDays) || 30,
        maxVersionsPerPage: Number(values.maxVersionsPerPage) || 10,
        autoCleanup: !!values.autoCleanup,
        detectionEnabled: values.detectionEnabled !== false,
        ignoredDomains: normalizeDomainFilterList(values.ignoredDomains),
        sizeDisplayMode: values.sizeDisplayMode === "compressed" ? "compressed" : "uncompressed",
        fetchDelayMs: Number(values.fetchDelayMs ?? 300),
        fetchTimeoutMs: Number(values.fetchTimeoutMs) || 30_000,
        fetchConcurrency: Math.max(1, Number(values.fetchConcurrency) || 6),
        maxMapBytes: Number(values.maxMapBytes) || 50 * 1024 * 1024,
        uiLanguage: values.uiLanguage || "auto",
      },
    }, (resp) => {
      setSaving(false);
      const err = runtimeMessageError();
      if (err) {
        console.error("[SourceD] updateSettings message failed:", err);
        message.error(err.message);
        return;
      }
      if (!resp?.ok) {
        message.error(resp?.error || i18nMessage("dashboardSaveFailed"));
        return;
      }
      message.success(i18nMessage("dashboardSaved"));
      onReload();
    });
  }, [message, onReload]);

  return (
    <Form form={form} layout="vertical" onFinish={handleSave}>
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Flex vertical gap={12}>
            <Card size="small" title={i18nMessage("dashboardSettingsGroupAnalysis")}>
              <Form.Item name="detectionEnabled" valuePropName="checked" style={{ marginBottom: 12 }}>
                <Switch checkedChildren={i18nMessage("dashboardSettingDetectionEnabled")} unCheckedChildren={i18nMessage("dashboardSettingDetectionEnabled")} />
              </Form.Item>
              <Form.Item label={i18nMessage("dashboardSettingIgnoredDomains")} name="ignoredDomains" extra={i18nMessage("dashboardSettingIgnoredDomainsHelp")} style={{ marginBottom: 0 }}>
                <Input.TextArea rows={5} placeholder={i18nMessage("dashboardSettingIgnoredDomainsPlaceholder")} />
              </Form.Item>
            </Card>
            <Card size="small" title={i18nMessage("dashboardSettingsGroupDisplay")}>
              <Form.Item label={i18nMessage("dashboardSettingLanguage")} name="uiLanguage">
                <Select
                  options={[
                    { value: "auto", label: i18nMessage("dashboardSettingLanguageAuto") },
                    { value: "en-US", label: "English" },
                    { value: "zh-CN", label: "中文" },
                  ]}
                />
              </Form.Item>
              <Form.Item label={i18nMessage("dashboardSettingSizeDisplayMode")} name="sizeDisplayMode" style={{ marginBottom: 0 }}>
                <Select
                  options={[
                    { value: "uncompressed", label: i18nMessage("dashboardSettingSizeDisplayUncompressed") },
                    { value: "compressed", label: i18nMessage("dashboardSettingSizeDisplayCompressed") },
                  ]}
                />
              </Form.Item>
            </Card>
          </Flex>
        </Col>
        <Col xs={24} md={12}>
          <Flex vertical gap={12}>
            <Card size="small" title={i18nMessage("dashboardSettingsGroupCapture")}>
              <Divider style={{ margin: "0 0 12px" }} orientation="left" orientationMargin={0}>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {i18nMessage("dashboardSettingsGroupFetch")}
                </Text>
              </Divider>
              <Row gutter={12}>
                <Col xs={24} sm={12}>
                  <Form.Item
                    label={i18nMessage("dashboardSettingFetchDelayMs")}
                    name="fetchDelayMs"
                    extra={i18nMessage("dashboardSettingFetchDelayMsHelp")}
                  >
                    <InputNumber min={0} max={5000} addonAfter="ms" style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12}>
                  <Form.Item
                    label={i18nMessage("dashboardSettingFetchTimeoutMs")}
                    name="fetchTimeoutMs"
                    extra={i18nMessage("dashboardSettingFetchTimeoutMsHelp")}
                  >
                    <InputNumber min={500} max={120_000} addonAfter="ms" style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item
                label={i18nMessage("dashboardSettingFetchConcurrency")}
                name="fetchConcurrency"
                extra={i18nMessage("dashboardSettingFetchConcurrencyHelp")}
              >
                <InputNumber min={1} max={20} style={{ width: "100%" }} />
              </Form.Item>
              <Divider style={{ margin: "4px 0 12px" }} orientation="left" orientationMargin={0}>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {i18nMessage("dashboardSettingsGroupPerFile")}
                </Text>
              </Divider>
              <Form.Item
                label={i18nMessage("dashboardSettingMaxMapBytes")}
                name="maxMapBytes"
                style={{ marginBottom: 0 }}
                extra={
                  <span>
                    {i18nMessage("dashboardSettingMaxMapBytesHelp")}
                    {maxMapBytesValue > 0 && (
                      <span style={{ color: "#bfbfbf" }}>{` · ${fileSizeIEC(maxMapBytesValue)}`}</span>
                    )}
                  </span>
                }
              >
                <InputNumber min={1024 * 1024} max={500 * 1024 * 1024} style={{ width: "100%" }} />
              </Form.Item>
            </Card>
            <Card size="small" title={i18nMessage("dashboardSettingsGroupRetention")}>
              <Form.Item label={i18nMessage("dashboardSettingRetentionDays")} name="retentionDays">
                <InputNumber min={1} max={365} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label={i18nMessage("dashboardSettingMaxVersions")} name="maxVersionsPerPage">
                <InputNumber min={1} max={100} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name="autoCleanup" valuePropName="checked" style={{ marginBottom: 0 }}>
                <Switch checkedChildren={i18nMessage("dashboardSettingAutoCleanup")} unCheckedChildren={i18nMessage("dashboardSettingAutoCleanup")} />
              </Form.Item>
            </Card>
            <Form.Item style={{ marginBottom: 0 }}>
              <Button type="primary" htmlType="submit" loading={saving}>
                {i18nMessage("dashboardSaveSettings")}
              </Button>
            </Form.Item>
          </Flex>
        </Col>
      </Row>
    </Form>
  );
}
