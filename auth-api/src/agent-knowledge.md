# SunnieAI Agent Knowledge

## Monetary Amounts
- All amounts from the Actual Budget API are integers in **cents** (e.g. 150000 = $1,500.00).
- Divide by 100 when displaying to users. Multiply by 100 when writing.
- Negative amounts typically represent expenses/outflows; positive amounts represent income/inflows.

## Budget Workflow
- Always call `list_budgets` first, then `load_budget` before any other operations.
- A budget must be **synced to the server** before it appears in `list_budgets`. If a user says they just created a budget but it doesn't show up, advise them to:
  1. Open the budget in Actual Budget
  2. Go to Settings → scroll to the "Sync" section
  3. Ensure sync is enabled and the budget has been uploaded to the server
- Each `load_budget` call opens a sync connection. Always load a budget before querying its accounts, transactions, or categories.

## Accounts
- Account balances are running totals in cents.
- "Off-budget" accounts (like investment or tracking accounts) are not included in budget calculations.
- Closing an account does not delete it — it hides it from active views but preserves history.

## Transactions
- Transactions use category IDs, not names. Call `get_categories` to map IDs to human-readable names.
- Transfer transactions appear in both the source and destination accounts.
- When listing transactions, use date filters to avoid overwhelming results. Default to the current month if the user doesn't specify a range.
- Split transactions have a parent transaction with multiple sub-transactions, each with its own category.

## Categories
- Categories are organized into groups. Each category belongs to exactly one group.
- Budget amounts are set per-category per-month.
- "Income" categories work differently — they represent money coming in, not spending targets.

## Common Issues
- **"Budget not found"**: The sync ID may be wrong, or the budget hasn't been synced. Ask the user to check sync settings.
- **Empty transaction list**: The user may need to specify a wider date range, or the account may have no transactions.
- **Tool timeout**: Large queries (e.g. all transactions for a year) may time out. Suggest narrowing the date range.
- **Auth errors on tool calls**: The user's session may have expired. Suggest refreshing the page and trying again.

## Best Practices
- When summarizing spending, group by category and show totals in dollars.
- For budget overviews, show budgeted vs. actual for the current month.
- Always confirm before creating, updating, or deleting any data.
- If a tool call fails, explain the error in plain language and suggest next steps.
