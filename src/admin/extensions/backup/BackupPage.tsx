import React, { useState, useRef } from 'react';

type Status = { type: 'success' | 'error'; message: string } | null;

const StatusBlock = ({ status }: { status: Status }) => {
  if (!status) return null;
  return (
    <div
      style={{
        marginTop: '16px',
        padding: '12px 16px',
        backgroundColor: status.type === 'success' ? '#EAFBE7' : '#FCECEA',
        color: status.type === 'success' ? '#328048' : '#B72B1A',
        borderRadius: '4px',
        fontSize: '14px',
        fontWeight: 500,
      }}
    >
      {status.type === 'success' ? '✓ ' : '✕ '}
      {status.message}
    </div>
  );
};

const BackupPage = () => {
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<Status>(null);

  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState<Status>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const getToken = () => localStorage.getItem('jwtToken');

  const handleDownload = async () => {
    setDownloadLoading(true);
    setDownloadStatus(null);

    try {
      const response = await fetch('/backup/download', {
        headers: { Authorization: `Bearer ${getToken()}` },
      });

      if (!response.ok) {
        let msg = response.statusText;
        try { const e = await response.json(); msg = e?.error?.message || e?.message || msg; } catch (_) {}
        throw new Error(msg);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `barbitch-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setDownloadStatus({ type: 'success', message: 'Backup downloaded successfully!' });
    } catch (err: any) {
      setDownloadStatus({ type: 'error', message: err.message || 'Unknown error' });
    } finally {
      setDownloadLoading(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    const confirmed = window.confirm(
      `⚠️ DANGER!\n\nThis will OVERWRITE ALL current data with:\n"${file.name}"\n\nThis cannot be undone. Are you absolutely sure?`
    );
    if (!confirmed) return;

    setRestoreLoading(true);
    setRestoreStatus(null);

    try {
      const fileContent = await file.text();

      // Validate JSON client-side before uploading
      let parsed: any;
      try {
        parsed = JSON.parse(fileContent);
      } catch {
        throw new Error('File is not valid JSON');
      }
      if (!parsed?.tables) throw new Error('Invalid backup format: missing "tables" field');

      const response = await fetch('/backup/restore', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: fileContent,
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || response.statusText);

      setRestoreStatus({
        type: 'success',
        message: `Restored ${result.restored} of ${result.total} tables.${result.skipped ? ` Skipped: ${result.skipped}.` : ''}`,
      });
    } catch (err: any) {
      setRestoreStatus({ type: 'error', message: err.message || 'Unknown error' });
    } finally {
      setRestoreLoading(false);
    }
  };

  const btnStyle = (bg: string, disabled: boolean, color?: string): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 28px',
    backgroundColor: disabled ? '#9898C0' : bg,
    color: color || 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '14px',
    fontWeight: 600,
  });

  return (
    <div style={{ padding: '48px 32px', maxWidth: '680px' }}>
      <h1 style={{ fontSize: '26px', fontWeight: 700, marginBottom: '4px', color: '#ffffff' }}>
        Database Backup
      </h1>
      <p style={{ color: '#a5a5ba', marginBottom: '40px', fontSize: '14px' }}>
        Download and restore a full JSON snapshot of all database tables.
      </p>

      {/* Download */}
      <div
        style={{
          padding: '24px',
          border: '1px solid rgb(50, 50, 77)',
          borderRadius: '8px',
          marginBottom: '24px',
          backgroundColor: 'rgb(33, 33, 52)',
        }}
      >
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'rgb(192, 192, 207)', marginBottom: '6px' }}>
          Download Backup
        </h2>
        <p style={{ fontSize: '13px', color: 'rgb(165, 165, 186)', marginBottom: '16px' }}>
          Export all database tables as a JSON file. Store it in a safe place.
        </p>
        <button onClick={handleDownload} disabled={downloadLoading} style={btnStyle('#4945FF', downloadLoading)}>
          {downloadLoading ? '⏳ Generating...' : '⬇ Download Backup'}
        </button>
        <StatusBlock status={downloadStatus} />
      </div>

      {/* Restore */}
      <div
        style={{
          padding: '24px',
          border: '1px solid rgb(50, 50, 77)',
          borderRadius: '8px',
          backgroundColor: 'rgb(33, 33, 52)',
        }}
      >
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'rgb(238, 94, 82)', marginBottom: '6px' }}>
          Restore from Backup
        </h2>
        <p style={{ fontSize: '13px', color: '#a5a5ba', marginBottom: '4px' }}>
          Upload a previously downloaded backup file.{' '}
          <strong style={{ color: 'rgb(238, 94, 82)' }}>This will overwrite ALL current data.</strong>
        </p>
        <p style={{ fontSize: '13px', color: '#a5a5ba', marginBottom: '16px' }}>
          Accepted format: .json file generated by this plugin.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        <button
          onClick={() => !restoreLoading && fileInputRef.current?.click()}
          disabled={restoreLoading}
          style={btnStyle('#ee5e52', restoreLoading, '#212134')}
        >
          {restoreLoading ? '⏳ Restoring...' : '⬆ Choose File & Restore'}
        </button>

        <StatusBlock status={restoreStatus} />
      </div>
    </div>
  );
};

export default BackupPage;
