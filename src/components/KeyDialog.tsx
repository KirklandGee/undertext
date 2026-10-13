import { FormEvent, useState } from "react";

interface Props {
  hasKey: boolean;
  message?: string;
  onSave(key: string): Promise<void>;
  onRemove(): Promise<void>;
  onClose(): void;
}

export function KeyDialog({ hasKey, message, onSave, onRemove, onClose }: Props) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await onSave(key);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <form
        className="dialog"
        role="dialog"
        aria-label="Anthropic API key"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <h2>Anthropic API key</h2>
        {message && <p className="dialog-alert">{message}</p>}
        <p>
          The Lab and AI alternatives send your text to Claude. The key is stored in the macOS Keychain. Create one at
          platform.claude.com → API keys.
        </p>
        <input
          autoFocus
          type="password"
          placeholder={hasKey ? "A key is saved. Paste a new one to replace it." : "sk-ant-…"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {error && <p className="dialog-alert">{error}</p>}
        <div className="dialog-actions">
          {hasKey && (
            <button type="button" className="danger" onClick={() => void onRemove()}>
              Remove key
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!key.trim()}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
