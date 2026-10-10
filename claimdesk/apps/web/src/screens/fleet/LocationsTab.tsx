// owned by ap-booking
/**
 * Fleet > Locations (docs/SUPREME-AUTOPILOT.md §B.3, §I.8): where the cars are kept. One location is the default.
 * The availability ranking uses the postcode district (no geocoding is bundled); coordinates are optional.
 */
import { useState } from 'react';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { TextInput } from '../../components/Form';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Loading } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { isApiError } from '../../api/client';
import { bookingsApi, useBookingMutation, useLocations } from '../../api/bookingsApi';
import './booking.css';

export function LocationsTab() {
  const toast = useToast();
  const locations = useLocations();
  const [name, setName] = useState('');
  const [postcode, setPostcode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useBookingMutation(() => bookingsApi.addLocation({ name: name.trim(), postcode: postcode.trim() || null }));
  const makeDefault = useBookingMutation((id: string) => bookingsApi.patchLocation(id, { isDefault: true }));

  const submit = async () => {
    setError(null);
    try {
      const l = await add.mutateAsync(undefined);
      toast.success(`${l.name} added`);
      setName('');
      setPostcode('');
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e));
    }
  };

  return (
    <Card title="Locations">
      <p className="small muted">Where the cars are kept. Set a car's location on the car; the search ranks cars by postcode district when the delivery postcode is known.</p>
      {locations.isLoading && <Loading />}
      <ul className="stack-sm" style={{ listStyle: 'none', padding: 0 }}>
        {(locations.data?.items ?? []).map((l) => (
          <li key={l.id} className="row">
            <strong>{l.name}</strong>
            <span className="muted">{l.postcode ?? 'no postcode'}</span>
            {l.isDefault ? (
              <Badge tone="green">Default</Badge>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => void makeDefault.mutateAsync(l.id).then(() => toast.success(`${l.name} is now the default`))}>
                Make default
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="row">
        <TextInput label="Name" value={name} onChange={setName} />
        <TextInput label="Postcode" value={postcode} onChange={setPostcode} />
        <Button variant="primary" disabled={!name.trim()} loading={add.isPending} onClick={() => void submit()}>
          Add location
        </Button>
      </div>
      <ErrorAlert message={error} />
    </Card>
  );
}
