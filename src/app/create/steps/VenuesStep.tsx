'use client';

import * as React from 'react';
import { Plus, Pencil, Trash2, MapPin, Users, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FilterChip } from '@/components/ui/filter-chip';
import { RemovableChip } from '@/components/ui/removable-chip';
import { ConfirmInline } from '@/components/ui/confirm-inline';
import { Field } from '@/app/e/[slug]/admin/settings/_components/SectionCard';
import { plural } from '@/lib/format';
import type { WizardState, WizardAction, WizardVenue } from '../useWizardState';

// ============================================================================
// Types
// ============================================================================

interface VenuesStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}

interface VenueFormData {
  name: string;
  capacity: string;
  features: string[];
  address: string;
}

// ============================================================================
// Constants
// ============================================================================

export const VENUE_FEATURES = [
  { value: 'projector', label: 'Projector' },
  { value: 'microphone', label: 'Microphone' },
  { value: 'whiteboard', label: 'Whiteboard' },
  { value: 'video-conferencing', label: 'Video conferencing' },
  { value: 'accessible', label: 'Accessible' },
  { value: 'outdoor', label: 'Outdoor' },
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'wifi', label: 'Wi-Fi' },
];

const INITIAL_FORM_DATA: VenueFormData = {
  name: '',
  capacity: '',
  features: [],
  address: '',
};

// ============================================================================
// Helper Functions
// ============================================================================

function generateId(): string {
  return crypto.randomUUID();
}

export function featureLabel(value: string): string {
  const preset = VENUE_FEATURES.find((f) => f.value === value);
  if (preset) return preset.label;
  const words = value.split('-').filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

// ============================================================================
// Venue Card Component
// ============================================================================

interface VenueCardProps {
  venue: WizardVenue;
  onEdit: (venue: WizardVenue) => void;
  onDelete: (id: string) => void;
}

function VenueCard({ venue, onEdit, onDelete }: VenueCardProps) {
  const [confirming, setConfirming] = React.useState(false);

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h4 className="font-medium text-base truncate">{venue.name}</h4>
          {venue.address && (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-1">
              <MapPin className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              <span className="truncate">{venue.address}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button variant="ghost" size="icon-sm" onClick={() => onEdit(venue)} aria-label={`Edit ${venue.name}`}>
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${venue.name}`}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {venue.capacity !== null && venue.capacity > 0 && (
        <p className="text-sm text-muted-foreground flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          Capacity: {venue.capacity}
        </p>
      )}

      {venue.features.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {venue.features.map((feature) => (
            <Badge key={feature} variant="secondary">{featureLabel(feature)}</Badge>
          ))}
        </div>
      )}

      {confirming && (
        <ConfirmInline
          message="Delete this room? Any time slots assigned to it are removed too."
          confirmLabel="Delete"
          destructive
          onConfirm={() => { onDelete(venue.id); setConfirming(false); }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Venue Form Component
// ============================================================================

interface VenueFormProps {
  initialData?: WizardVenue | null;
  onSubmit: (data: VenueFormData) => void;
  onCancel: () => void;
  isEditing: boolean;
}

const normalizeFeatureValue = (raw: string) =>
  raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function VenueForm({ initialData, onSubmit, onCancel, isEditing }: VenueFormProps) {
  const [formData, setFormData] = React.useState<VenueFormData>(() => {
    if (initialData) {
      return {
        name: initialData.name,
        capacity: initialData.capacity !== null ? String(initialData.capacity) : '',
        features: initialData.features,
        address: initialData.address,
      };
    }
    return INITIAL_FORM_DATA;
  });

  const [error, setError] = React.useState<string | null>(null);
  const [customFeatureInput, setCustomFeatureInput] = React.useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      setError('Give the room a name');
      return;
    }
    setError(null);
    onSubmit(formData);
  };

  const toggleFeature = (feature: string) => {
    setFormData((prev) => ({
      ...prev,
      features: prev.features.includes(feature) ? prev.features.filter((f) => f !== feature) : [...prev.features, feature],
    }));
  };

  const handleAddCustomFeature = () => {
    const value = normalizeFeatureValue(customFeatureInput);
    if (!value) return;
    if (!formData.features.includes(value)) {
      setFormData((prev) => ({ ...prev, features: [...prev.features, value] }));
    }
    setCustomFeatureInput('');
  };

  const customFeatures = formData.features.filter((v) => !VENUE_FEATURES.some((f) => f.value === v));

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <Field label="Room name" htmlFor="venue-name" error={error}>
        <Input
          id="venue-name"
          placeholder="e.g. Main stage, Workshop room A"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          maxLength={100}
          error={!!error}
          autoFocus
        />
      </Field>

      <Field label="Capacity (optional)" htmlFor="venue-capacity" hint="How many people fit. Helps match popular sessions to bigger rooms.">
        <Input
          id="venue-capacity"
          type="number"
          inputMode="numeric"
          placeholder="e.g. 40"
          value={formData.capacity}
          onChange={(e) => setFormData({ ...formData, capacity: e.target.value })}
          min={1}
          max={100000}
          className="max-w-[200px]"
        />
      </Field>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Features (optional)</legend>
        <div className="flex flex-wrap gap-2">
          {VENUE_FEATURES.map((feature) => (
            <FilterChip key={feature.value} pressed={formData.features.includes(feature.value)} onClick={() => toggleFeature(feature.value)}>
              {feature.label}
            </FilterChip>
          ))}
          {customFeatures.map((value) => (
            <RemovableChip key={value} label={featureLabel(value)} variant="default" onRemove={() => toggleFeature(value)} />
          ))}
        </div>
        <div className="flex gap-2 items-center">
          <Input
            placeholder="Add a feature (e.g. standing desks)"
            aria-label="Custom feature"
            value={customFeatureInput}
            onChange={(e) => setCustomFeatureInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddCustomFeature();
              }
            }}
            maxLength={40}
            className="max-w-xs"
          />
          <Button type="button" variant="outline" size="sm" onClick={handleAddCustomFeature} disabled={!customFeatureInput.trim()}>
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            Add
          </Button>
        </div>
      </fieldset>

      <Field label="Address (optional)" htmlFor="venue-address" hint="Where to find this room, if it differs from the gathering’s address.">
        <Input
          id="venue-address"
          placeholder="Building, floor, or a separate address"
          value={formData.address}
          onChange={(e) => setFormData({ ...formData, address: e.target.value })}
          maxLength={300}
        />
      </Field>

      <div className="flex items-center justify-end gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit">{isEditing ? 'Save changes' : 'Add room'}</Button>
      </div>
    </form>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function VenuesStep({ state, dispatch }: VenuesStepProps) {
  const { venues, dates } = state;
  const [showForm, setShowForm] = React.useState(false);
  const [editingVenue, setEditingVenue] = React.useState<WizardVenue | null>(null);

  const isVirtualOnly = dates.locationType === 'virtual';

  const handleAddVenue = () => {
    setEditingVenue(null);
    setShowForm(true);
  };

  const handleEditVenue = (venue: WizardVenue) => {
    setEditingVenue(venue);
    setShowForm(true);
  };

  const handleDeleteVenue = (id: string) => {
    dispatch({ type: 'REMOVE_VENUE', payload: id });
  };

  const handleFormSubmit = (data: VenueFormData) => {
    const venueData: WizardVenue = {
      id: editingVenue?.id || generateId(),
      name: data.name.trim(),
      capacity: data.capacity ? parseInt(data.capacity, 10) : null,
      features: data.features,
      address: data.address.trim(),
    };

    if (editingVenue) {
      dispatch({ type: 'UPDATE_VENUE', payload: { id: editingVenue.id, updates: venueData } });
    } else {
      dispatch({ type: 'ADD_VENUE', payload: venueData });
    }

    setShowForm(false);
    setEditingVenue(null);
  };

  const handleFormCancel = () => {
    setShowForm(false);
    setEditingVenue(null);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Rooms and spaces</CardTitle>
          <CardDescription>
            {isVirtualOnly
              ? 'This gathering is online, so rooms are optional. Add virtual rooms (a call link each) or add spaces later if you decide to meet in person.'
              : 'The physical or virtual spaces where sessions happen. Realistic capacities and equipment tags help match sessions to rooms; descriptive names (“Building A, room 101”) help people find them.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {venues.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {venues.map((venue) => (
                <VenueCard key={venue.id} venue={venue} onEdit={handleEditVenue} onDelete={handleDeleteVenue} />
              ))}
            </div>
          ) : (
            !showForm && (
              <div className="text-center py-8 border-2 border-dashed rounded-lg">
                <MapPin className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" aria-hidden="true" />
                <p className="text-muted-foreground mb-4">No rooms yet. You can also add them from the organizer workspace later.</p>
                <Button variant="outline" onClick={handleAddVenue}>
                  <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
                  Add a room
                </Button>
              </div>
            )
          )}

          {venues.length > 0 && !showForm && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">{plural(venues.length, 'room')}</p>
              <Button onClick={handleAddVenue} variant="outline">
                <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
                Add a room
              </Button>
            </div>
          )}

          {showForm && (
            <Card className="border-primary/50">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{editingVenue ? 'Edit room' : 'New room'}</CardTitle>
                  <Button variant="ghost" size="icon-sm" onClick={handleFormCancel} aria-label="Close the room form">
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <VenueForm
                  key={editingVenue?.id ?? 'new'}
                  initialData={editingVenue}
                  onSubmit={handleFormSubmit}
                  onCancel={handleFormCancel}
                  isEditing={!!editingVenue}
                />
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default VenuesStep;
