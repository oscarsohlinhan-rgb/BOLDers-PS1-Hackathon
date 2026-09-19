"""Checks for the advisory weekday-planning engine (api/dayplan.py)."""
import os

DATA = "/tmp/PS1-latest/01_data"
SAMPLE = "/tmp/PS1-latest/03_submission_sample"
FILES = [
    "01_LINES.csv", "02_STATIONS.csv", "03_SECTORS.csv",
    "04_LOCATION_SUPPLY.csv", "05_BUFFER_LOCATION.csv",
    "06_PARAMETERS.csv", "07_PROJECT_DETAILS.csv",
    "08_ACTIVITY_DETAILS.csv",
]


def _bundle():
    from api import dayplan as D
    out = {}
    for name in FILES + [D.SCHEDULE_ACCESS, D.SCHEDULE_OCCUPANCY]:
        folder = SAMPLE if name.startswith("SCHEDULE_") else DATA
        with open(os.path.join(folder, name), encoding="utf-8-sig") as handle:
            out[name] = handle.read()
    return out


def _pairs():
    import csv
    import io
    access = list(csv.DictReader(
        io.StringIO(open(os.path.join(SAMPLE, "SCHEDULE_ACCESS.csv"),
                         encoding="utf-8-sig").read())))
    return {(row["activity_id"], int(row["week"])) for row in access}


def run(check):
    from api import dayplan as D

    base = _bundle()
    pairs = _pairs()

    first = D.plan_weekdays(dict(base), {}, "spread")
    check("dayplan-spread-ok",
          first["status"] == "ok" and first["engine"] == D.ENGINE
          and first["strategy"] == "spread",
          first.get("status"))
    got = {(pick["activity_id"], pick["week"]) for pick in first["picks"]}
    check("dayplan-covers-every-scheduled-night",
          got == pairs, f"({len(got)}/{len(pairs)})")
    check("dayplan-days-in-range-and-reasoned",
          all(0 <= pick["day"] <= 6 and pick["reason"]
              and pick["source"] == "suggested"
              and pick["day_name"] in D.DAY_NAMES
              for pick in first["picks"]),
          str(len(first["picks"])))

    repeat = D.plan_weekdays(dict(base), {}, "spread")
    check("dayplan-deterministic",
          repeat["picks"] == first["picks"], "")

    front = D.plan_weekdays(dict(base), {}, "frontload")
    check("dayplan-frontload-ok",
          front["status"] == "ok" and
          {(p["activity_id"], p["week"]) for p in front["picks"]} == pairs,
          front.get("status"))

    fixed = D.plan_weekdays(dict(base), {"A001|22": 6}, "spread")
    check("dayplan-fixed-never-suggested",
          all(not (p["activity_id"] == "A001" and p["week"] == 22)
              for p in fixed["picks"]),
          "")

    bad_strategy = D.plan_weekdays(dict(base), {}, "someday")
    check("dayplan-rejects-bad-strategy",
          bad_strategy["status"] == "rejected_input", "")

    bad_fixed = D.plan_weekdays(dict(base), {"A001|22": 9}, "spread")
    check("dayplan-rejects-bad-fixed-day",
          bad_fixed["status"] == "rejected_input", "")

    missing = dict(base)
    del missing[D.SCHEDULE_ACCESS]
    check("dayplan-rejects-missing-schedule",
          D.plan_weekdays(missing, {}, "spread")["status"]
          == "rejected_input", "")

    from api.model import load_instance

    inst = load_instance(DATA)
    occ = {}
    import csv as _csv
    with open(os.path.join(SAMPLE, "SCHEDULE_OCCUPANCY.csv"),
              encoding="utf-8-sig") as handle:
        for row in _csv.DictReader(handle):
            occ.setdefault((row["activity_id"], int(row["week"])),
                           []).append((row["location_id"],
                                       row["co_share_group"]))
    feet = {}
    for (aid, week), slots in occ.items():
        activity = inst.activities[aid]
        nature = inst.contracts[activity.contract].nature
        locs = sorted({loc for loc, _ in slots})
        foot = set(inst.buffer_footprint(locs, nature))
        foot |= set(inst.mirror_blocks(locs, nature))
        feet[(aid, week)] = (foot, {loc: group for loc, group in slots})
    clashes = []
    by_day = {}
    for pick in first["picks"]:
        by_day.setdefault((pick["week"], pick["day"]), []).append(
            pick["activity_id"])
    for (week, day), aids in sorted(by_day.items()):
        for i in range(len(aids)):
            for j in range(i + 1, len(aids)):
                foot_a, groups_a = feet[(aids[i], week)]
                foot_b, groups_b = feet[(aids[j], week)]
                shared = foot_a & foot_b
                same_possession = any(
                    loc in groups_b and groups_a.get(loc) == groups_b[loc]
                    and groups_a.get(loc)
                    for loc in groups_a)
                if shared and not same_possession:
                    clashes.append((week, day, aids[i], aids[j],
                                    sorted(shared)[:2]))
    check("dayplan-no-track-overlap-per-night", not clashes,
          str(clashes[:3]))
