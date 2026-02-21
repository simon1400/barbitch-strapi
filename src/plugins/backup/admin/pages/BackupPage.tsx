import React, { useState } from 'react';

const BackupPage = () => {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const handleDownload = async () => {
    setLoading(true);
    setStatus(null);

    try {
      const token = localStorage.getItem('jwtToken');
      const response = await fetch('/backup/download', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        let message = response.statusText;
        try {
          const err = await response.json();
          message = err?.error?.message || err?.message || message;
        } catch (_) {}
        throw new Error(message);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `barbitch-backup-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setStatus({ type: 'success', message: 'Backup downloaded successfully!' });
    } catch (err: any) {
      setStatus({ type: 'error', message: err.message || 'Unknown error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '48px 32px', maxWidth: '640px' }}>
      <h1 style={{ fontSize: '26px', fontWeight: 700, marginBottom: '8px', color: '#ffffff' }}>
        Database Backup
      </h1>
      <p style={{ color: '#a5a5ba', marginBottom: '32px', fontSize: '14px', lineHeight: '1.6' }}>
        Downloads a full JSON snapshot of all database tables.
        Store it safely — it contains all your salon data (shifts, cash, salaries, clients, etc.).
      </p>

      <button
        onClick={handleDownload}
        disabled={loading}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          padding: '12px 28px',
          backgroundColor: loading ? '#9898C0' : '#4945FF',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: loading ? 'not-allowed' : 'pointer',
          fontSize: '14px',
          fontWeight: 600,
        }}
      >
        {loading ? '⏳ Generating backup...' : '⬇ Download Backup'}
      </button>

      {status && (
        <div
          style={{
            marginTop: '20px',
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
      )}
    </div>
  );
};

export default BackupPage;
