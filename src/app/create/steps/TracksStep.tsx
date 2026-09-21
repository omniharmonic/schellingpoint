'use client';

import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { ColorPicker, DEFAULT_PRESETS } from '@/components/ui/color-picker';
import { ConfirmInline } from '@/components/ui/confirm-inline';
import { Field } from '@/app/e/[slug]/admin/settings/_components/SectionCard';
import { contrastingTextColor } from '@/app/e/[slug]/admin/settings/_components/constants';
import { cn } from '@/lib/utils';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import type { WizardState, WizardAction, WizardTrack } from '../useWizardState';

// ============================================================================
// Types
// ============================================================================

interface TracksStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}

interface TrackFormData {
  name: string;
  color: string;
  description: string;
}

// ============================================================================
// Constants
// ============================================================================

const INITIAL_FORM_DATA: TrackFormData = {
  name: '',
  color: DEFAULT_PRESETS[0],
  description: '',
};

// ============================================================================
// Helper Functions
// ============================================================================

function generateId(): string {
  return crypto.randomUUID();
}

function isValidHexColor(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
}

// ============================================================================
// Sub-Components
// ============================================================================

interface TrackCardProps {
  track: WizardTrack;
  onEdit: () => void;
  onDelete: () => void;
}

function TrackCard({ track, onEdit, onDelete }: TrackCardProps) {
  const [confirming, setConfirming] = React.useState(false);

  return (
    <div className={cn('rounded-lg border bg-card p-4 space-y-3 transition-colors', !confirming && 'hover:bg-accent/50')}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <span
            className="flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium"
            style={{ backgroundColor: track.color, color: contrastingTextColor(track.color) }}
          >
            {track.name}
          </span>
          {track.description && (
            <p className="text-sm text-muted-foreground truncate pt-1">{track.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button type="button" variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Edit the ${track.name} track`}>
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setConfirming(true)}
            className="text-destructive hover:text-destructive"
            aria-label={`Delete the ${track.name} track`}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {confirming && (
        <ConfirmInline
          message={`Delete the “${track.name}” track?`}
          confirmLabel="Delete"
          destructive
          layout="inline"
          onConfirm={() => { onDelete(); setConfirming(false); }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

interface TrackFormProps {
  initialData?: TrackFormData;
  onSubmit: (data: TrackFormData) => void;
  onCancel: () => void;
  submitLabel: string;
}

function TrackForm({ initialData, onSubmit, onCancel, submitLabel }: TrackFormProps) {
  const [formData, setFormData] = React.useState<TrackFormData>(initialData || INITIAL_FORM_DATA);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.name.trim()) {
      onSubmit({ ...formData, name: formData.name.trim(), description: formData.description.trim() });
    }
  };

  const isValid = formData.name.trim().length > 0 && isValidHexColor(formData.color);

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-lg bg-accent/30" noValidate>
      <Field label="Track name" htmlFor="track-name">
        <Input
          id="track-name"
          placeholder="e.g. Technical, Design, Governance"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          maxLength={50}
          autoFocus
        />
      </Field>

      <ColorPicker label="Color" value={formData.color} onChange={(color) => setFormData({ ...formData, color })} />

      <Field label="Description (optional)" htmlFor="track-description">
        <Textarea
          id="track-description"
          placeholder="What kind of sessions belong in this track?"
          value={formData.description}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          rows={2}
          className="min-h-[80px]"
        />
      </Field>

      <div className="flex items-center justify-end gap-3">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={!isValid}>{submitLabel}</Button>
      </div>
    </form>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function TracksStep({ state, dispatch }: TracksStepProps) {
  const { tracks } = state;

  const [isAddingTrack, setIsAddingTrack] = React.useState(false);
  const [editingTrackId, setEditingTrackId] = React.useState<string | null>(null);

  const handleAddTrack = (data: TrackFormData) => {
    dispatch({ type: 'ADD_TRACK', payload: { id: generateId(), ...data } });
    setIsAddingTrack(false);
  };

  const handleUpdateTrack = (id: string, data: TrackFormData) => {
    dispatch({ type: 'UPDATE_TRACK', payload: { id, updates: data } });
    setEditingTrackId(null);
  };

  const editingTrack = editingTrackId ? tracks.find((t) => t.id === editingTrackId) : null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Tracks</CardTitle>
          <CardDescription>
            Tracks group sessions by theme so people can find what interests them. Optional; you can add and change them later.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {tracks.length > 0 ? (
            <div className="space-y-2">
              {tracks.map((track) =>
                editingTrackId === track.id && editingTrack ? (
                  <TrackForm
                    key={track.id}
                    initialData={{ name: editingTrack.name, color: editingTrack.color, description: editingTrack.description }}
                    onSubmit={(data) => handleUpdateTrack(track.id, data)}
                    onCancel={() => setEditingTrackId(null)}
                    submitLabel="Save changes"
                  />
                ) : (
                  <TrackCard
                    key={track.id}
                    track={track}
                    onEdit={() => { setEditingTrackId(track.id); setIsAddingTrack(false); }}
                    onDelete={() => dispatch({ type: 'REMOVE_TRACK', payload: track.id })}
                  />
                )
              )}
            </div>
          ) : (
            !isAddingTrack && (
              <div className="text-center py-8 px-4 border border-dashed rounded-lg">
                <p className="text-muted-foreground">No tracks yet. Sessions can still be proposed without them.</p>
              </div>
            )
          )}

          {isAddingTrack ? (
            <TrackForm onSubmit={handleAddTrack} onCancel={() => setIsAddingTrack(false)} submitLabel="Add track" />
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => { setIsAddingTrack(true); setEditingTrackId(null); }}
            >
              <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
              Add a track
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default TracksStep;
