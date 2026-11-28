# Pera tests

Browser tests that drive the real app (index.html, app.js) with a stand-in for Supabase, so nothing touches your account.

```
pip install playwright && python3 -m playwright install chromium
cd tests && npm i axe-core@4 && cd ..
bash tests/run_all.sh
```

| Test | Checks |
|---|---|
| test_sync_safety | an out-of-date device can't wipe savings; edits on two devices (also offline) both survive; on-device copies restore |
| test_undo_categories_duplicates_goals | Undo after sync, quick typing, categories, statement duplicate detection, savings goals |
| test_sheets_back_and_signin_expiry | swipe-down / Back closes sheets; expired sign-in is reported |
| test_sync_hang_timeout | a server that never answers is reported after 20 s, then retried |
| test_animations | counters, chart drawing, reduced-motion |
| test_shortcuts | clean shortcut names, expense vs income |
| test_forecast | savings forecast after the deposit plan ends |
| test_reports | spending trend, calendar, savings rate, PayLater payoff (light + dark) |
| test_search_and_day_groups | search, day-grouped month entries, sticky sheet headers |
| test_accessibility_and_speed | axe-core WCAG checks on every tab, load time on a slow phone |
| test_password_reset_fonts_a11y | forgot / change password, bundled fonts, axe |

`fixtures/` holds **invented** data from `make_fixtures.py`. This repo is public: never put real statements or backups here.
Most tests print what they saw; screenshots go to `tests/out/`.
