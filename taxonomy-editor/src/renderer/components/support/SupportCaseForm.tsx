// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@bridge';
import type { SupportCaseCreatePayload } from '../../bridge/types';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useDialog } from '../shared/useDialog'; // t/4909
import './SupportCaseForm.css';

declare const __APP_VERSION__: string;

const isWeb = import.meta.env.VITE_TARGET === 'web';

const MAX_SUBJECT = 200;
const MAX_DESCRIPTION = 5000;
const MIN_DESCRIPTION = 20;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB
const ALLOWED_MIME_RE = /^(image\/|video\/webm|application\/json|text\/plain)/;

type FormState = 'idle' | 'submitting' | 'uploading' | 'success' | 'error';
type Priority = 'low' | 'medium' | 'high';

interface AttachmentEntry {
  file: File;
  id: string; // local tracking ID
}

interface SupportCaseFormProps {
  onClose: () => void;
  onSubmitted?: (caseId: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getSystemInfo(): SupportCaseCreatePayload['systemInfo'] {
  return {
    appVersion: __APP_VERSION__,
    browser: navigator.userAgent,
    os: navigator.platform,
    deploymentMode: isWeb ? 'web' : 'electron',
  };
}

export function SupportCaseForm({ onClose, onSubmitted }: SupportCaseFormProps) {
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('low');
  const [attachments, setAttachments] = useState<AttachmentEntry[]>([]);
  const [formState, setFormState] = useState<FormState>('idle');
  const [uploadProgress, setUploadProgress] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [attachError, setAttachError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // t/4909: role/aria-modal/aria-labelledby below were already correct; this replaces the old
  // window-level Escape listener with the shared hook (closeOnEscape mirrors the pre-existing
  // guard), and adds the Tab trap + initial-focus/return-focus this dialog never had.
  const { dialogRef: formRef } = useDialog({
    onCancel: onClose,
    closeOnEscape: formState !== 'submitting' && formState !== 'uploading',
  });

  const totalBytes = attachments.reduce((sum, a) => sum + a.file.size, 0);
  const subjectTrimmed = subject.trim();
  const descTrimmed = description.trim();
  const canSubmit = formState === 'idle'
    && subjectTrimmed.length > 0
    && subjectTrimmed.length <= MAX_SUBJECT
    && descTrimmed.length >= MIN_DESCRIPTION
    && descTrimmed.length <= MAX_DESCRIPTION;

  const addAttachmentError = useCallback((msg: string) => {
    setAttachError(msg);
    setTimeout(() => setAttachError(''), 4000);
  }, []);

  const validateAndAddFiles = useCallback((files: File[]) => {
    setAttachError('');
    const current = [...attachments];
    let currentTotal = totalBytes;

    for (const file of files) {
      if (current.length >= MAX_ATTACHMENTS) {
        addAttachmentError(`Maximum ${MAX_ATTACHMENTS} attachments allowed`);
        break;
      }
      if (!ALLOWED_MIME_RE.test(file.type)) {
        addAttachmentError(`File type not allowed: ${file.type || 'unknown'}. Allowed: images, video/webm, JSON, text.`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        addAttachmentError(`${file.name} exceeds 10 MB limit (${formatBytes(file.size)})`);
        continue;
      }
      if (currentTotal + file.size > MAX_TOTAL_BYTES) {
        addAttachmentError(`Adding ${file.name} would exceed 50 MB total limit`);
        continue;
      }
      current.push({ file, id: crypto.randomUUID() });
      currentTotal += file.size;
    }

    setAttachments(current);
  }, [attachments, totalBytes, addAttachmentError]);

  // Clipboard paste for screenshots
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      if (!formRef.current?.contains(document.activeElement) && document.activeElement !== formRef.current) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            const ext = item.type.split('/')[1] || 'png';
            const named = new File([file], `screenshot-${Date.now()}.${ext}`, { type: file.type });
            imageFiles.push(named);
          }
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        validateAndAddFiles(imageFiles);
      }
    };
    window.addEventListener('paste', handler);
    return () => window.removeEventListener('paste', handler);
  }, [validateAndAddFiles]);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      validateAndAddFiles(Array.from(files));
    }
    // Reset so the same file can be selected again
    e.target.value = '';
  }, [validateAndAddFiles]);

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const handleIncludeDiagnostics = useCallback(() => {
    const recorder = getGlobalRecorder();
    if (!recorder) {
      addAttachmentError('Flight recorder not available');
      return;
    }
    try {
      const { ndjson } = recorder.buildDump('manual');
      const file = new File([ndjson], 'flight-recorder-dump.jsonl', { type: 'application/json' });
      validateAndAddFiles([file]);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'support-case-form',
        level: 'error',
        message: 'Failed to build flight recorder dump for attachment',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      addAttachmentError('Failed to capture diagnostics');
    }
  }, [validateAndAddFiles, addAttachmentError]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    setFormState('submitting');
    setErrorMsg('');

    let caseId: string;
    try {
      const result = await api.createSupportCase({
        subject: subjectTrimmed,
        description: descTrimmed,
        priority,
        systemInfo: getSystemInfo(),
      });
      caseId = result.id;
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'support-case-form',
        level: 'error',
        message: 'Failed to create support case',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setFormState('error');
      setErrorMsg(`Failed to create case: ${(err as Error).message || String(err)}`);
      return;
    }

    if (attachments.length > 0) {
      setFormState('uploading');
      for (let i = 0; i < attachments.length; i++) {
        setUploadProgress(`Uploading ${i + 1}/${attachments.length}...`);
        try {
          await api.uploadCaseAttachment(caseId, attachments[i].file);
        } catch (err) {
          getGlobalRecorder()?.record({
            type: 'system.error',
            component: 'support-case-form',
            level: 'error',
            message: `Failed to upload attachment ${attachments[i].file.name}`,
            error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
          });
          setFormState('error');
          setErrorMsg(`Case created (${caseId}) but attachment upload failed: ${attachments[i].file.name}. You can retry from My Cases.`);
          return;
        }
      }
    }

    setFormState('success');
    onSubmitted?.(caseId);
    setTimeout(() => onClose(), 2000);
  }, [canSubmit, subjectTrimmed, descTrimmed, priority, attachments, onSubmitted, onClose]);

  const systemInfo = getSystemInfo();
  const hasDiagnosticsAttached = attachments.some(a => a.file.name === 'flight-recorder-dump.jsonl');

  return (
    <div className="dialog-overlay" onMouseDown={formState === 'submitting' || formState === 'uploading' ? undefined : onClose}>
      <div
        ref={formRef}
        className="dialog support-form-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="support-form-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 id="support-form-title" className="support-form-title">Report a Problem</h3>

        {formState === 'success' ? (
          <div className="support-form-success-wrap">
            <p className="support-form-success-text">Case submitted successfully</p>
            <p className="support-form-success-subtext">You can track your case from the Help menu.</p>
          </div>
        ) : (
          <div className="support-form-body">
            {/* Subject */}
            <div>
              <label className="support-form-label">
                Subject <span className="support-form-label-hint">({subjectTrimmed.length}/{MAX_SUBJECT})</span>
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Brief summary of the issue"
                maxLength={MAX_SUBJECT}
                disabled={formState !== 'idle'}
                className="support-form-input"
              />
            </div>

            {/* Description */}
            <div>
              <label className="support-form-label">
                Description <span className="support-form-label-hint">
                  ({descTrimmed.length}/{MAX_DESCRIPTION}{descTrimmed.length > 0 && descTrimmed.length < MIN_DESCRIPTION ? `, min ${MIN_DESCRIPTION}` : ''})
                </span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what happened, what you expected, and steps to reproduce"
                maxLength={MAX_DESCRIPTION}
                disabled={formState !== 'idle'}
                rows={5}
                className="support-form-textarea"
              />
            </div>

            {/* Priority */}
            <div>
              <label className="support-form-label">Priority</label>
              <div className="support-form-priority-row">
                {(['low', 'medium', 'high'] as const).map((p) => (
                  <label key={p} className="support-form-priority-label">
                    <input
                      type="radio"
                      name="priority"
                      value={p}
                      checked={priority === p}
                      onChange={() => setPriority(p)}
                      disabled={formState !== 'idle'}
                    />
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </label>
                ))}
              </div>
            </div>

            {/* Attachments */}
            <div>
              <label className="support-form-label">
                Attachments <span className="support-form-label-hint">
                  ({attachments.length}/{MAX_ATTACHMENTS}, {formatBytes(totalBytes)})
                </span>
              </label>

              {attachments.length > 0 && (
                <div className="support-form-attachment-list">
                  {attachments.map((a) => (
                    <div key={a.id} className="support-form-attachment-item">
                      <span className="support-form-attachment-name">
                        {a.file.name}
                      </span>
                      <span className="support-form-attachment-size">{formatBytes(a.file.size)}</span>
                      <button
                        onClick={() => handleRemoveAttachment(a.id)}
                        disabled={formState !== 'idle'}
                        className="support-form-attachment-remove-btn"
                        aria-label={`Remove ${a.file.name}`}
                        title="Remove"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="support-form-attach-actions">
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={handleFileSelect}
                  disabled={formState !== 'idle' || attachments.length >= MAX_ATTACHMENTS}
                >
                  Add File
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={handleIncludeDiagnostics}
                  disabled={formState !== 'idle' || hasDiagnosticsAttached || attachments.length >= MAX_ATTACHMENTS}
                  title={hasDiagnosticsAttached ? 'Diagnostics already attached' : 'Attach flight recorder dump'}
                >
                  {hasDiagnosticsAttached ? 'Diagnostics Attached' : 'Include Diagnostics'}
                </button>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/webm,application/json,text/plain"
                multiple
                onChange={handleFileInputChange}
                className="support-form-file-input-hidden"
              />

              <p className="support-form-hint-text">
                Paste screenshots with Ctrl+V. Max 10 MB per file, 50 MB total.
              </p>

              {attachError && (
                <p className="support-form-attach-error">{attachError}</p>
              )}
            </div>

            {/* System Info */}
            <div>
              <label className="support-form-label">
                System Info <span className="support-form-label-hint">(auto-captured)</span>
              </label>
              <div className="support-form-sysinfo-box">
                <div>Version: {systemInfo.appVersion}</div>
                <div>Mode: {systemInfo.deploymentMode}</div>
                <div className="support-form-ellipsis" title={systemInfo.browser}>
                  Browser: {systemInfo.browser}
                </div>
                <div>OS: {systemInfo.os}</div>
              </div>
            </div>

            {/* Error message */}
            {formState === 'error' && errorMsg && (
              <p className="support-form-error-msg">{errorMsg}</p>
            )}
          </div>
        )}

        <div className="dialog-actions support-form-actions">
          {formState === 'success' ? (
            <button className="btn btn-primary" onClick={onClose}>Close</button>
          ) : (
            <>
              <button
                className="btn btn-ghost"
                onClick={onClose}
                disabled={formState === 'submitting' || formState === 'uploading'}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSubmit}
                disabled={!canSubmit}
              >
                {formState === 'submitting' ? 'Submitting...'
                  : formState === 'uploading' ? uploadProgress
                  : formState === 'error' ? 'Retry'
                  : 'Submit Case'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
