import { useState, useEffect, useCallback, useRef } from "react";
import { App, Flex, Input, Modal, Typography } from "antd";
import { fileSizeIEC, i18nMessage } from "../../shared/utils.mjs";

const { Text } = Typography;

export default function ImportMapsModal({ open, importing, onCancel, onImport }) {
  const { message } = App.useApp();
  const [pageUrl, setPageUrl] = useState("");
  const [title, setTitle] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [reading, setReading] = useState(false);
  const inputRef = useRef(null);
  const pageUrlRef = useRef("");
  const titleRef = useRef("");
  const selectedFilesRef = useRef([]);

  useEffect(() => {
    pageUrlRef.current = pageUrl;
  }, [pageUrl]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    selectedFilesRef.current = selectedFiles;
  }, [selectedFiles]);

  useEffect(() => {
    if (!open) {
      setPageUrl("");
      setTitle("");
      setSelectedFiles([]);
      setReading(false);
      pageUrlRef.current = "";
      titleRef.current = "";
      selectedFilesRef.current = [];
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [open]);

  const handleFileChange = useCallback((event) => {
    const nextFiles = Array.from(event.target.files || []);
    selectedFilesRef.current = nextFiles;
    setSelectedFiles(nextFiles);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmedUrl = pageUrlRef.current.trim();
    const filesToImport = selectedFilesRef.current;
    if (!trimmedUrl || !filesToImport.length) return;

    setReading(true);
    let files;
    try {
      files = await Promise.all(filesToImport.map(async (file) => {
        const text = typeof file.text === "function"
          ? await file.text()
          : await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result || "");
            reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
            reader.readAsText(file);
          });

        return {
          name: file.name,
          mapUrl: file.webkitRelativePath || file.name,
          content: String(text || ""),
        };
      }));
    } catch (err) {
      console.error("[SourceD] ImportMapsModal file read failed:", err);
      message.error(err?.message || "Failed to read selected files");
      setReading(false);
      return;
    }
    setReading(false);

    onImport({
      pageUrl: trimmedUrl,
      title: titleRef.current.trim(),
      files,
    });
  }, [message, onImport]);

  return (
    <Modal
      title={i18nMessage("dashboardImportTitle")}
      open={open}
      onCancel={onCancel}
      onOk={handleSubmit}
      okText={i18nMessage("dashboardImportConfirm")}
      okButtonProps={{ disabled: !pageUrl.trim() || !selectedFiles.length || reading, loading: reading || importing }}
      cancelButtonProps={{ disabled: reading || importing }}
      destroyOnHidden
    >
      <Flex vertical gap={12}>
        <Text type="secondary">{i18nMessage("dashboardImportHelp")}</Text>
        <Input
          value={pageUrl}
          onChange={(event) => setPageUrl(event.target.value)}
          placeholder={i18nMessage("dashboardImportUrlPlaceholder")}
          aria-label={i18nMessage("dashboardImportUrlLabel")}
        />
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={i18nMessage("dashboardImportTitlePlaceholder")}
          aria-label={i18nMessage("dashboardImportPageTitleLabel")}
        />
        <Flex vertical gap={8}>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".map,application/json"
            onChange={handleFileChange}
            aria-label={i18nMessage("dashboardImportFileLabel")}
          />
          {selectedFiles.length ? (
            <div style={{ border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
              {selectedFiles.map((file, index) => (
                <Flex
                  key={`${file.name}-${index}`}
                  justify="space-between"
                  align="center"
                  style={{
                    width: "100%",
                    minWidth: 0,
                    padding: "8px 12px",
                    borderTop: index === 0 ? "none" : "1px solid #f0f0f0",
                  }}
                >
                  <Text ellipsis={{ tooltip: file.name }} style={{ minWidth: 0 }}>{file.name}</Text>
                  <Text type="secondary" style={{ marginLeft: 8, flexShrink: 0 }}>{fileSizeIEC(file.size || 0)}</Text>
                </Flex>
              ))}
            </div>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {i18nMessage("dashboardImportEmpty")}
            </Text>
          )}
        </Flex>
      </Flex>
    </Modal>
  );
}
