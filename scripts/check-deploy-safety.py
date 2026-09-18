"""Fail CI before deployment if a stale tree can drop features or database records."""
from pathlib import Path

root = Path(__file__).resolve().parents[1]
required = [
    'apps/web/src/components/bookings/register/BookingRegister.tsx',
    'apps/web/src/components/bookings/issues/BookingIssuesPanel.tsx',
    'apps/api/src/services/bookingRegister.ts',
    'apps/api/src/services/bookingIssues.ts',
    'apps/api/src/routes/bookingProjects.ts',
    'apps/api/src/routes/stockCounts.ts',
]
for name in required:
    assert (root / name).is_file(), f'Required production feature missing: {name}'
page = (root / 'apps/web/app/bookings/page.tsx').read_text()
assert 'BookingRegister' in page, 'Booking page no longer renders the production register'
for name in ['deploy.sh', 'scripts/deploy-api.sh', '.github/workflows/deploy-rsync.yml']:
    contents = (root / name).read_text()
    for flag in ['--accept-data-loss', '--force-reset']:
        assert flag not in contents, f'Destructive database sync in {name}: {flag}'
schema = (root / 'apps/api/prisma/schema.prisma').read_text()
for model in ['BookingProject', 'ProjectDay', 'ProjectLot', 'ProjectBillingPeriod', 'StockCount', 'StockCountLine']:
    assert f'model {model} ' in schema, f'Required database model missing: {model}'
workflow = (root / '.github/workflows/deploy-rsync.yml').read_text()
assert "--exclude '*.db*'" in workflow, 'SQLite WAL/SHM files must survive rsync'
print('Production deployment guards passed')
