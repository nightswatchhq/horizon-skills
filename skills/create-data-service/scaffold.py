#!/usr/bin/env python3
"""horizon-skills — Horizon data service generator.

Reads an answers JSON file, fills the template tree, and writes a complete,
buildable data service repo. See SKILL.md for the answers schema.

    python3 scaffold.py --answers answers.json --out ./my-service
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATES = HERE / "templates"

# Horizon addresses per network — see reference/gotchas.md.
NETWORKS = {
    "arbitrum_sepolia": {
        "chain_id": "421614",
        "graph_tally_collector": "0xacC71844EF6beEF70106ABe6E51013189A1f3738",
        "controller": "0x9DB3ee191681f092607035d9BDA6e59FbEaCa695",
        "payments_escrow": "0x09B985a2042848A08bA59060EaF0f07c6F5D4d54",
        "rpc_default": "https://sepolia-rollup.arbitrum.io/rpc",
    },
    "arbitrum_one": {
        "chain_id": "42161",
        "graph_tally_collector": "0x8f69F5C07477Ac46FBc491B1E6D91E2bb0111A9e",
        "controller": "0x0000000000000000000000000000000000000000",  # resolve via Controller call
        "payments_escrow": "0xf6Fcc27aAf1fcD8B254498c9794451d82afC673E",
        "rpc_default": "https://arb1.arbitrum.io/rpc",
    },
}


def fail(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def build_tier_enum(tiers) -> str:
    """Render the Solidity `DataTier` enum body from the tiers list.

    Accepts ["BASIC", ...] or [{"name": "BASIC", "comment": "..."}, ...].
    """
    norm = []
    for t in tiers:
        if isinstance(t, str):
            norm.append((t.strip().upper(), ""))
        else:
            norm.append((str(t["name"]).strip().upper(), str(t.get("comment", "")).strip()))
    if not norm:
        fail("at least one tier is required")
    width = max(len(name) for name, _ in norm)
    lines = []
    for i, (name, comment) in enumerate(norm):
        is_last = i == len(norm) - 1
        sep = "" if is_last else ","
        token = f"{name}{sep}"
        if comment:
            lines.append(f"        {token:<{width + 2}} // {i} — {comment}")
        else:
            lines.append(f"        {token}".rstrip())
    return "\n".join(lines)


def make_subs(ans: dict) -> dict:
    for req in ("service_slug", "service_name", "service_description", "archetype"):
        if not ans.get(req):
            fail(f"missing required field: {req}")
    if ans["archetype"] not in ("proxy", "pipeline"):
        fail("archetype must be 'proxy' or 'pipeline'")

    network = ans.get("network", "arbitrum_sepolia")
    if network not in NETWORKS:
        fail(f"unknown network: {network}")
    net = NETWORKS[network]

    slug = ans["service_slug"]
    name = ans["service_name"]
    tiers = ans.get("tiers", ["BASIC", "DECODED", "SQL"])
    first = tiers[0]
    first_tier = (first if isinstance(first, str) else first["name"]).strip().upper()

    return {
        "first_tier": first_tier,
        "service_slug": slug,
        "service_crate": slug.replace("-", "_"),
        "archetype": ans["archetype"],
        "service_slug_upper": slug.upper().replace("-", "_"),
        "service_name": name,
        "service_title": ans.get("service_title", f"{name} Data Service"),
        "service_description": ans["service_description"],
        "pricing": bool(ans.get("pricing", False)),
        "base_price_per_cu": str(ans.get("base_price_per_cu", "4000000000000")),
        "min_provision": str(ans.get("min_provision", "555e18")),
        "burn_cut_ppm": str(ans.get("burn_cut_ppm", "10000")),
        "data_service_cut_ppm": str(ans.get("data_service_cut_ppm", "10000")),
        "default_port": str(ans.get("default_port", "8090")),
        "upstream_url": ans.get("upstream_url", "http://127.0.0.1:5678"),
        "network": network,
        "eip712_chain_id": net["chain_id"],
        "graph_tally_collector": net["graph_tally_collector"],
        "controller": net["controller"],
        "payments_escrow": net["payments_escrow"],
        "arbitrum_rpc_default": net["rpc_default"],
        "data_tier_enum": build_tier_enum(tiers),
    }


TOKEN_RE = re.compile(r"\{\{(\w+)\}\}")


def substitute(text: str, subs: dict) -> str:
    def repl(m):
        key = m.group(1)
        if key not in subs:
            fail(f"unknown template token: {{{{{key}}}}}")
        return subs[key]
    return TOKEN_RE.sub(repl, text)


def render_tree(src: Path, dst: Path, subs: dict, written: list) -> None:
    for item in sorted(src.rglob("*")):
        if item.is_dir():
            continue
        rel = item.relative_to(src)
        rel_str = substitute(str(rel), subs)
        if rel_str.endswith(".tmpl"):
            rel_str = rel_str[:-len(".tmpl")]
        out_path = dst / rel_str
        out_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            content = item.read_text()
            out_path.write_text(substitute(content, subs))
        except UnicodeDecodeError:
            shutil.copyfile(item, out_path)
        if out_path.suffix == ".sh":
            out_path.chmod(0o755)
        written.append(out_path)


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate a Horizon data service.")
    ap.add_argument("--answers", required=True, help="path to answers JSON")
    ap.add_argument("--out", required=True, help="output directory for the new service")
    args = ap.parse_args()

    ans = json.loads(Path(args.answers).read_text())
    subs = make_subs(ans)
    out = Path(args.out)
    if out.exists() and any(out.iterdir()):
        fail(f"output dir {out} exists and is not empty")
    out.mkdir(parents=True, exist_ok=True)

    written = []
    render_tree(TEMPLATES / "common", out, subs, written)
    render_tree(TEMPLATES / "contracts", out / "contracts", subs, written)
    render_tree(TEMPLATES / subs["archetype"], out, subs, written)
    # Optional: overlay a per-endpoint pricing policy onto the gateway crate.
    # Overwrites the gateway's main.rs + Cargo.toml and adds pricing.rs.
    if subs["pricing"]:
        render_tree(TEMPLATES / "pricing-overlay", out, subs, written)

    written = sorted(set(written))
    priced = " +pricing" if subs["pricing"] else ""
    print(f"horizon-skills — generated {subs['service_title']} ({subs['network']}, {subs['archetype']}{priced}) at {out}\n")
    for p in written:
        print(f"  {p.relative_to(out)}")
    print(f"\n{len(written)} files. Next: vendor contract libs, fill .env + gateway.toml, "
          f"`forge build && forge test`, `cargo build`. See README.md.")


if __name__ == "__main__":
    main()
