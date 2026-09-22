export const copy = {
  meta: {
    title: "Poolix — Liquidity Infrastructure for Robinhood Chain",
    description:
      "Poolix provides liquidity infrastructure, swaps, pools, and analytics for Robinhood Chain.",
  },
  nav: {
    home: "Home",
    swap: "Swap",
    /** Token and pool discovery, combined into one surface. */
    explore: "Explore",
    /** Singular in navigation, where it names the surface rather than the collection. */
    pool: "Pool",
    pools: "Pools",
    portfolio: "Portfolio",
    analytics: "Analytics",
    tokens: "Tokens",
    developers: "Developers",
    docs: "Docs",
    dashboard: "Dashboard",
    settings: "Settings",
    search: "Search",
  },
  wallet: {
    connect: "Connect Wallet",
    connected: "Wallet Connected",
    disconnect: "Disconnect",
    copyAddress: "Copy Address",
    addressCopied: "Address Copied",
    viewWallet: "View Wallet",
    viewOnExplorer: "View on Explorer",
    wrongNetwork: "Wrong Network",
    switchNetwork: "Switch Network",
    requestRejected: "Request Rejected",
    unavailable: "Wallet Unavailable",
  },
  swap: {
    swap: "Swap",
    from: "From",
    to: "To",
    /** The swap form names the sides by what the user is doing, not by direction. */
    sell: "Sell",
    buy: "Buy",
    details: "Details",
    selectToken: "Select Token",
    enterAmount: "Enter Amount",
    max: "Max",
    balance: "Balance",
    rate: "Rate",
    priceImpact: "Price Impact",
    minimumReceived: "Minimum Received",
    slippageTolerance: "Slippage Tolerance",
    networkFee: "Network Fee",
    route: "Route",
    approve: "Approve",
    confirmSwap: "Confirm Swap",
    submitted: "Swap Submitted",
    pending: "Swap Pending",
    complete: "Swap Complete",
    failed: "Swap Failed",
    insufficientBalance: "Insufficient Balance",
    insufficientLiquidity: "Insufficient Liquidity",
    quoteUnavailable: "Quote Unavailable",
  },
  liquidity: {
    pools: "Pools",
    liquidityProvider: "Liquidity Provider",
    addLiquidity: "Add Liquidity",
    removeLiquidity: "Remove Liquidity",
    yourLiquidity: "Your Liquidity",
    liquidityPosition: "Liquidity Position",
    poolShare: "Pool Share",
    poolReserves: "Pool Reserves",
    poolFee: "Pool Fee",
    tradingFees: "Trading Fees",
    totalLiquidity: "Total Liquidity",
    createPool: "Create Pool",
    poolCreated: "Pool Created",
  },
  poolData: {
    tvl: "TVL",
    volume24h: "Volume 24H",
    fees24h: "Fees 24H",
    poolShare: "Pool Share",
    liquidity: "Liquidity",
    volume: "Volume",
    fees: "Fees",
    apr: "APR",
    apy: "APY",
    transactions: "Transactions",
  },
  analytics: {
    analytics: "Analytics",
    overview: "Overview",
    totalValueLocked: "Total Value Locked",
    // Denominated in the chain's native asset, not USD: these come from the WETH side
    // of each swap, so no price feed is involved.
    tradingVolume: "Trading Volume (ETH)",
    tradingFees: "Trading Fees (ETH)",
    activeUsers: "Active Users",
    transactions: "Transactions",
    topPools: "Top Pools",
    topTokens: "Top Tokens",
    marketActivity: "Market Activity",
  },
  timeframes: ["24H", "7D", "30D", "90D", "1Y", "ALL"],
  tokens: {
    token: "Token",
    symbol: "Symbol",
    contract: "Contract",
    contractAddress: "Contract Address",
    price: "Price",
    liquidity: "Liquidity",
    volume: "Volume",
    holders: "Holders",
    pools: "Pools",
    transactions: "Transactions",
    verified: "Verified",
    unverified: "Unverified",
  },
  search: {
    placeholder: "Search tokens, pools, or addresses...",
  },
  transaction: {
    status: {
      preparing: "Preparing",
      awaitingApproval: "Awaiting Approval",
      approving: "Approving",
      approved: "Approved",
      confirming: "Confirming",
      pending: "Pending",
      confirmed: "Confirmed",
      failed: "Failed",
      rejected: "Rejected",
    },
    pendingTitle: "Transaction Pending",
    pendingMessage: "Waiting for network confirmation.",
    confirmedTitle: "Transaction Confirmed",
    confirmedMessage: "Your transaction has been confirmed onchain.",
    failedTitle: "Transaction Failed",
    viewOnExplorer: "View on Explorer",
    done: "Done",
    tryAgain: "Try Again",
  },
  loading: {
    generic: "Loading...",
    quote: "Fetching quote...",
    pools: "Fetching pools...",
    liquidity: "Loading liquidity...",
    analytics: "Loading analytics...",
    explore: "Reading the scanned pools and the indexed Pons launches...",
    portfolio: "Reading the scanned pool universe...",
    preparingTransaction: "Preparing transaction...",
    waitingForConfirmation: "Waiting for confirmation...",
  },
  empty: {
    pools: {
      title: "No liquidity pools found.",
      message: "Try adjusting your search or check back later.",
    },
    transactions: {
      title: "No transactions yet.",
      message: "Your recent activity will appear here.",
    },
    positions: {
      title: "No liquidity positions yet.",
      message: "Add liquidity to start earning eligible trading fees.",
    },
    tokens: {
      title: "No tokens found.",
      message: "Try searching by token name, symbol, or address.",
    },
  },
  errors: {
    walletNotConnected: {
      title: "Wallet Not Connected",
      message: "Please connect your wallet to continue.",
    },
    wrongNetwork: {
      title: "Wrong Network",
      message: "You're connected to the wrong network. Switch to Robinhood Chain to continue.",
    },
    insufficientBalance: {
      title: "Insufficient Balance",
      message: "You don't have enough ETH to complete this transaction.",
    },
    insufficientLiquidity: {
      title: "Insufficient Liquidity",
      message: "Insufficient Liquidity for this trade.",
    },
    priceImpactTooHigh: {
      title: "Price Impact Too High",
      message: "Price impact is too high. Try a smaller amount.",
    },
    slippageExceeded: {
      title: "Price Moved",
      message: "The price changed beyond your slippage tolerance. Review the quote and try again.",
    },
    deadlineExpired: {
      title: "Transaction Expired",
      message: "The transaction deadline passed before confirmation. Please try again.",
    },
    quoteUnavailable: {
      title: "Quote Unavailable",
      message: "A quote couldn't be fetched for this trade. Try again or adjust the amount.",
    },
    rpcUnavailable: {
      title: "Network Unavailable",
      message: "Unable to connect to the network. Please try again shortly.",
    },
    transactionRejected: {
      title: "Transaction Rejected",
      message: "The transaction was rejected.",
    },
    transactionReverted: {
      title: "Transaction Failed",
      message: "The transaction failed. Please try again.",
    },
    approvalFailed: {
      title: "Token Approval Failed",
      message: "The token approval didn't complete. Please try again.",
    },
    contractNotConfigured: {
      title: "Contract Not Configured",
      message: "The contract required for this action isn't configured on this network.",
    },
    unsafeTransaction: {
      title: "Transaction Blocked",
      message:
        "This transaction failed a safety check and was not sent to your wallet. Reload the page and try again.",
    },
    unexpected: {
      title: "Unexpected Error",
      message: "The request couldn't be completed. Please try again.",
    },
  },
  tooltips: {
    tvl: {
      title: "TVL",
      body: "Total value of assets currently deposited in the pool.",
    },
    priceImpact: {
      title: "Price Impact",
      body: "The estimated change in execution price caused by your trade size.",
    },
    slippageTolerance: {
      title: "Slippage Tolerance",
      body: "The maximum price movement you are willing to accept.",
    },
  },
  data: {
    unavailable: "--",
    unavailableLong: "Data unavailable",
  },
  status: {
    /** Maturity of the deployment. Shown in the footer badge. */
    beta: "Beta",
    /**
     * Security status. Kept separate from `beta` on purpose: the footer badge states
     * maturity, while the security section in /docs carries the audit disclosure. One
     * is not a substitute for the other.
     */
    unaudited: "Unaudited",
    contractNotConfigured: "Contract Not Configured",
  },
} as const;
