#!/usr/bin/env python3
"""Build data/oras.json: what can be caught where in Omega Ruby / Alpha Sapphire.

Sources (downloaded on each run):
  - PKHeX (github.com/kwsch/PKHeX): the games' own wild encounter tables
    (encounter_or.pkl / encounter_as.pkl) and gen 6 location names.
  - PokeAPI CSVs (github.com/PokeAPI/pokeapi): species names and types.

Gift and one-off encounters (starters, fossils, legendaries...) are listed by
hand below, taken from PKHeX's Encounters6AO.cs.

Usage: python3 tools/build_oras_encounters.py
"""

import csv
import io
import json
import os
import re
import struct
import urllib.request

PKHEX = 'https://raw.githubusercontent.com/kwsch/PKHeX/master/PKHeX.Core/Resources'
POKEAPI_CSV = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv'
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'oras.json')

VERSIONS = {'omega-ruby': 'or', 'alpha-sapphire': 'as'}

# Layout of an ORAS "standard" table (41 slots, fixed positions).
STANDARD_LAYOUT = (
    [('Grass', 12), ('Tall grass', 12), ('DexNav', 3), ('Surfing', 5),
     ('Old Rod', 3), ('Good Rod', 3), ('Super Rod', 3)]
)
AREA_TYPES = {6: 'Rock Smash', 7: 'Horde'}
# Walking encounters indoors are labelled "Cave" rather than "Grass".
CAVE_LIKE = re.compile(r'Cave|Cavern|Tunnel|Falls|Fiery Path|Mt\. Pyre|Victory Road|Hideout|'
                       r'Sky Pillar|Chamber|Mauville|Ruins|Tomb|Slab')

# Roughly the order you reach places in the story, so the location
# dropdown reads like a nuzlocke checklist. Anything missing goes last.
STORY_ORDER = [
    'Route 101', 'Route 103', 'Route 102', 'Petalburg City', 'Route 104', 'Petalburg Woods',
    'Rustboro City', 'Route 116', 'Rusturf Tunnel', 'Dewford Town', 'Route 106', 'Granite Cave',
    'Route 107', 'Route 108', 'Route 109', 'Slateport City', 'Route 110', 'Route 117',
    'Route 111', 'Route 112', 'Fiery Path', 'Route 113', 'Fallarbor Town', 'Route 114',
    'Meteor Falls', 'Route 115', 'Jagged Pass', 'Lavaridge Town', 'Route 105', 'Route 118',
    'Route 119', 'Route 120', 'Route 121', 'Safari Zone', 'Route 122', 'Mt. Pyre', 'Route 123',
    'Lilycove City', 'Team Magma Hideout', 'Team Aqua Hideout', 'Route 124', 'Mossdeep City',
    'Route 125', 'Shoal Cave', 'Route 127', 'Route 128', 'Seafloor Cavern', 'Route 126',
    'Sootopolis City', 'Cave of Origin', 'Route 129', 'Route 130', 'Route 131', 'Pacifidlog Town',
    'Route 132', 'Route 133', 'Route 134', 'Sky Pillar', 'Ever Grande City', 'Victory Road',
    'New Mauville', 'Sea Mauville', 'Southern Island', 'Sealed Chamber', 'Desert Ruins',
    'Island Cave', 'Ancient Tomb', 'Scorched Slab', 'Battle Resort',
    'Mirage Forest', 'Mirage Cave', 'Mirage Island', 'Mirage Mountain',
]

# (location, national dex, level, method, versions or None for both)
STATIC = [
    ('Route 101', 252, 5, 'Starter', None), ('Route 101', 255, 5, 'Starter', None),
    ('Route 101', 258, 5, 'Starter', None),
    ('Rustboro City', 345, 20, 'Fossil', None), ('Rustboro City', 347, 20, 'Fossil', None),
    ('Lavaridge Town', 360, 1, 'Gift egg', None), ('Lavaridge Town', 175, 1, 'Gift egg', None),
    ('Lavaridge Town', 352, 40, 'Static', None),
    ('Fallarbor Town', 25, 20, 'Gift', None),
    ('Route 119', 351, 30, 'Gift', None),
    ('Route 119', 100, 20, 'Static', None),
    ('Mossdeep City', 374, 1, 'Gift', None), ('Mossdeep City', 352, 45, 'Static', None),
    ('Battle Resort', 319, 40, 'Gift', None), ('Battle Resort', 323, 40, 'Gift', None),
    ('Southern Island', 381, 30, 'Gift', ['omega-ruby']), ('Southern Island', 380, 30, 'Gift', ['alpha-sapphire']),
    ('Southern Island', 380, 30, 'Static', ['omega-ruby']), ('Southern Island', 381, 30, 'Static', ['alpha-sapphire']),
    ('Cave of Origin', 383, 45, 'Static', ['omega-ruby']), ('Cave of Origin', 382, 45, 'Static', ['alpha-sapphire']),
    ('Team Magma Hideout', 101, 40, 'Static', ['omega-ruby']), ('Team Aqua Hideout', 101, 40, 'Static', ['alpha-sapphire']),
    ('Sky Pillar', 384, 70, 'Static', None), ('Sky Pillar', 386, 80, 'Static', None),
    ('Desert Ruins', 377, 40, 'Static', None), ('Island Cave', 378, 40, 'Static', None),
    ('Ancient Tomb', 379, 40, 'Static', None), ('Island Cave', 486, 50, 'Static', None),
    ('Sea Mauville', 249, 50, 'Static', ['alpha-sapphire']), ('Sea Mauville', 250, 50, 'Static', ['omega-ruby']),
    ('Sea Mauville', 442, 50, 'Static', None),
    ('Scorched Slab', 485, 50, 'Static', None),
]

METHOD_ORDER = ['Starter', 'Gift', 'Gift egg', 'Fossil', 'Static', 'Grass', 'Cave', 'Tall grass', 'Horde',
                'DexNav', 'Surfing', 'Rock Smash', 'Old Rod', 'Good Rod', 'Super Rod']


def fetch(url):
    with urllib.request.urlopen(url) as res:
        return res.read()


def read_csv(name):
    return list(csv.DictReader(io.StringIO(fetch(f'{POKEAPI_CSV}/{name}.csv').decode())))


def decode_areas(blob):
    """PKHeX BinLinker: 'ao', u16 count, u32 offsets[count+1], then areas."""
    assert blob[:2] == b'ao', 'unexpected file format'
    count = int.from_bytes(blob[2:4], 'little')
    offsets = struct.unpack(f'<{count + 1}I', blob[4:4 + 4 * (count + 1)])
    for i in range(count):
        area = blob[offsets[i]:offsets[i + 1]]
        location, area_type = int.from_bytes(area[:2], 'little'), area[2]
        slots = []
        for j in range(4, len(area), 4):
            raw = int.from_bytes(area[j:j + 2], 'little')
            slots.append((raw & 0x3FF, area[j + 2], area[j + 3]))  # species, min, max
        yield location, area_type, slots


def slot_methods(area_type, count):
    if area_type == 0:
        methods = [m for m, n in STANDARD_LAYOUT for _ in range(n)]
        assert len(methods) == count, f'standard table has {count} slots'
        return methods
    return [AREA_TYPES.get(area_type, f'Type {area_type}')] * count


def main():
    names = fetch(f'{PKHEX}/text/locations/gen6/text_xy_00000_en.txt').decode('utf-8-sig').splitlines()
    species = {int(r['id']): r['identifier'] for r in read_csv('pokemon') if r['is_default'] == '1'}
    type_names = {r['id']: r['identifier'] for r in read_csv('types')}
    types = {}
    for r in sorted(read_csv('pokemon_types'), key=lambda r: int(r['slot'])):
        types.setdefault(int(r['pokemon_id']), []).append(type_names[r['type_id']])

    # location -> dex -> {version -> set(methods)}, levels
    table = {}

    def add(location, dex, lo, hi, method, version):
        entry = table.setdefault(location, {}).setdefault(dex, {'methods': {}, 'min': lo, 'max': hi})
        entry['methods'].setdefault(version, set()).add(method)
        entry['min'], entry['max'] = min(entry['min'], lo), max(entry['max'], hi)

    for version, code in VERSIONS.items():
        blob = fetch(f'{PKHEX}/legality/wild/Gen6/encounter_{code}.pkl')
        for location, area_type, slots in decode_areas(blob):
            for (dex, lo, hi), method in zip(slots, slot_methods(area_type, len(slots))):
                if dex:
                    name = names[location]
                    if method == 'Grass' and CAVE_LIKE.search(name):
                        method = 'Cave'
                    add(name, dex, lo, hi, method, version)

    for location, dex, level, method, versions in STATIC:
        for version in versions or VERSIONS:
            add(location, dex, level, level, method, version)

    rank = {m: i for i, m in enumerate(METHOD_ORDER)}
    order = {name: i for i, name in enumerate(STORY_ORDER)}
    locations = []
    for name in sorted(table, key=lambda n: (order.get(n, len(order)), n)):
        pokemon = []
        for dex, e in table[name].items():
            methods = {v: sorted(ms, key=lambda m: rank.get(m, 99)) for v, ms in e['methods'].items()}
            pokemon.append({
                'species': species[dex],
                'dex': dex,
                'types': types.get(dex, []),
                'levels': [e['min'], e['max']],
                'methods': methods,
            })
        # Best method first, then by dex number.
        pokemon.sort(key=lambda p: (min(rank.get(m[0], 99) for m in p['methods'].values()), p['dex']))
        locations.append({'name': name, 'pokemon': pokemon})

    data = {
        'game': 'oras',
        'versions': {'omega-ruby': 'Omega Ruby', 'alpha-sapphire': 'Alpha Sapphire'},
        'source': 'PKHeX encounter tables + PokeAPI; built by tools/build_oras_encounters.py',
        'locations': locations,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    print(f'wrote {OUT}: {len(locations)} locations, '
          f'{sum(len(l["pokemon"]) for l in locations)} entries')


if __name__ == '__main__':
    main()
