/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Captain } from '../captain'
import { Block, BlockHash, BlockHeaderSerde, Target } from '../blockchain'
import { Strategy, Transaction } from '../strategy'
import { JsonSerializable } from '../serde'
import { Event } from '../event'
import { createRootLogger, Logger } from '../logger'
import { submitMetric } from '../telemetry'
import LeastRecentlyUsed from 'lru-cache'
import { MemPool } from '../memPool'
import { ErrorUtils } from '../utils'
import { Account } from '../account'

/**
 * Number of transactions we are willing to store in a single block.
 */
const MAX_TRANSACTIONS_PER_BLOCK = 10
const MINING_DIFFICULTY_CHANGE_TIMEOUT = 10000

type DirectorState = { type: 'STARTED' } | { type: 'STOPPED' }

/**
 * Responsible for directing miners about which block to mine.
 *
 * Listens for changes to the anchor chain head and emits a 'onBlockToMine' event
 * for each one.
 *
 * @typeParam E Note element stored in transactions and the notes Merkle Tree
 * @typeParam H the hash of an `E`. Used for the internal nodes and root hash
 *              of the notes Merkle Tree
 * @typeParam T Type of a transaction stored on Captain's chain.
 * @typeParam ST The serialized format of a `T`. Conversion between the two happens
 *               via the `strategy`.
 */
export class MiningDirector<
  E,
  H,
  T extends Transaction<E, H>,
  SE extends JsonSerializable,
  SH extends JsonSerializable,
  ST
> {
  readonly captain: Captain<E, H, T, SE, SH, ST>

  memPool: MemPool<E, H, T, SE, SH, ST>

  /**
   * The event creates a block header with loose transactions that have been
   * submitted to the network. It then waits for one of the miners to send it
   * a randomness value for that block. If one arrives, the block is reconstructed,
   * gossiped, and added to the local tree.
   */
  onBlockToMine = new Event<[{ miningRequestId: number; bytes: Buffer; target: Target }]>()

  /**
   * The chain strategy used to calculate miner's fees.
   */
  strategy: Strategy<E, H, T, SE, SH, ST>

  /**
   * Serde to convert block headers to jsonable objects.
   */
  blockHeaderSerde: BlockHeaderSerde<E, H, T, SE, SH, ST>

  /**
   * Reference blocks that we most recently emitted for miners to mine.
   */
  recentBlocks: LeastRecentlyUsed<number, Block<E, H, T, SE, SH, ST>>

  /**
   * Block currently being generated by the director. Nulled out after
   * the miner's fee is generated. (It will be set to null while
   * retrying)
   */
  currentBlockUnderConstruction: BlockHash | null = null

  /**
   * Next block to construct after currentBlockUnderConstruction finishes.
   */
  nextBlockToConstruct: BlockHash | null = null

  /**
   * The value to set on the `graffiti` field of newly generated blocks.
   */
  private _blockGraffiti: string
  get blockGraffiti(): string {
    return this._blockGraffiti
  }

  /**
   * The private spending key for this miner. This is used to construct the
   * miner's fee transaction for the block.
   */
  private _minerAccount: Account | null
  get minerAccount(): Account | null {
    return this._minerAccount
  }

  /**
   * Logger instance used in place of console logs
   */
  logger: Logger

  /**
   * Setting an interval every 10 seconds to re-calculate the target for the
   * currentBlock based on updated timestamp
   */
  miningDifficultyChangeTimeout: null | ReturnType<typeof setTimeout>

  private _state: Readonly<DirectorState> = { type: 'STOPPED' }

  get state(): Readonly<DirectorState> {
    return this._state
  }

  setState(state: Readonly<DirectorState>): void {
    this._state = state
  }

  /**
   * Identifier for each request of blocks that gets sent to miners. This
   * increases monotonically and allows director to figure out which
   * block it is receiving randomness for.
   */
  private miningRequestId: number

  constructor(
    captain: Captain<E, H, T, SE, SH, ST>,
    memPool: MemPool<E, H, T, SE, SH, ST>,
    logger: Logger = createRootLogger(),
    options: {
      graffiti?: string
      account?: Account
    } = {},
  ) {
    this.captain = captain
    this.memPool = memPool
    this._blockGraffiti = ''
    this._minerAccount = null
    this.strategy = captain.strategy
    this.blockHeaderSerde = new BlockHeaderSerde(captain.strategy)
    this.logger = logger.withTag('director')
    this.miningDifficultyChangeTimeout = null
    this.miningRequestId = 0
    this.recentBlocks = new LeastRecentlyUsed(50)

    this.captain.chain.onChainHeadChange.on((newChainHead: BlockHash) => {
      void this.onChainHeadChange(newChainHead).catch((err) => {
        this.logger.error(err)
      })
    })

    if (options.graffiti) {
      this.setBlockGraffiti(options.graffiti)
    }

    if (options.account) {
      this.setMinerAccount(options.account)
    }
  }

  async start(): Promise<void> {
    this.setState({ type: 'STARTED' })
    this.logger.debug('Mining director is running')

    const heaviestHead = await this.captain.chain.getHeaviestHead()
    if (heaviestHead) {
      await this.generateBlockToMine(heaviestHead.hash)
    }
  }

  isStarted(): boolean {
    return this.state.type === 'STARTED'
  }

  setBlockGraffiti(graffiti: string): void {
    this._blockGraffiti = graffiti
  }

  setMinerAccount(account: Account | null): void {
    this._minerAccount = account
  }

  /**
   * Event listener hooked up to changes in AnchorChain.
   *
   * When a new head is received it:
   *  * adds any transactions that we were attempting to mine back to the pool
   *  * Creates a new block with transactions from the pool
   *  * emits the header of the new block to any listening miners
   *  * stores block until either the head changes again or it is succesfully mined
   *
   * @param newChainHead The hash of the new head of the chain
   * @event onBlockToMine header of a new block that needs to have its randomness mined
   */
  async onChainHeadChange(newChainHead: BlockHash): Promise<void> {
    this.logger.debug('New chain head', newChainHead.toString('hex'))

    if (!this.isStarted()) {
      return
    }

    await this.generateBlockToMine(newChainHead)
  }

  async generateBlockToMine(chainHead: BlockHash): Promise<void> {
    // If we're already generating a block, update the next block to generate and exit
    this.nextBlockToConstruct = chainHead
    if (this.currentBlockUnderConstruction !== null) return

    // Continue generating while we have a new block to generate
    while (this.nextBlockToConstruct !== null && this.isStarted()) {
      this.currentBlockUnderConstruction = this.nextBlockToConstruct
      this.nextBlockToConstruct = null

      if (this.miningDifficultyChangeTimeout) {
        clearTimeout(this.miningDifficultyChangeTimeout)
      }

      let blockData = null

      try {
        blockData = await this.constructTransactionsAndFees(this.currentBlockUnderConstruction)
      } catch (error: unknown) {
        this.logger.debug(
          `An error occurred while creating the new block ${ErrorUtils.renderError(error)}`,
        )
      }

      if (blockData === null) {
        continue
      }

      const [minersFee, blockTransactions] = blockData
      await this.constructAndMineBlockWithRetry(minersFee, blockTransactions)
    }

    // No longer generating a block
    this.currentBlockUnderConstruction = null
  }

  async constructAndMineBlockWithRetry(minersFee: T, blockTransactions: T[]): Promise<void> {
    if (!this.isStarted()) {
      return
    }

    const canRetry = await this.constructAndMineBlock(minersFee, blockTransactions)
    // The current mining target is already at the initial - no need to try to lower it
    if (!canRetry) return

    if (this.miningDifficultyChangeTimeout) {
      clearTimeout(this.miningDifficultyChangeTimeout)
    }
    this.miningDifficultyChangeTimeout = setTimeout(() => {
      void this.constructAndMineBlockWithRetry(minersFee, blockTransactions)
    }, MINING_DIFFICULTY_CHANGE_TIMEOUT)
  }

  /**
   * Construct the transactions, header and miner fees used by constructAndMineBlock
   *
   * @param newChainHead The hash of the new head of the chain
   */

  async constructTransactionsAndFees(newChainHead: BlockHash): Promise<[T, T[]]> {
    if (!this._minerAccount) {
      throw Error('No miner account found to construct the transaction')
    }

    const blockTransactions = []

    // Fetch all transactions for the block
    for await (const transaction of this.memPool.get()) {
      if (blockTransactions.length >= MAX_TRANSACTIONS_PER_BLOCK) break

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blockTransactions.push(transaction)
    }

    // Sum the transaction fees
    let totalTransactionFees = BigInt(0)
    const transactionFees = await Promise.all(blockTransactions.map((t) => t.transactionFee()))
    for (const transactionFee of transactionFees) {
      totalTransactionFees += transactionFee
    }

    const blockHeader = await this.captain.chain.getBlockHeader(newChainHead)
    if (!blockHeader) {
      // Chain normally has a header for a heaviestHead. Block could be removed
      // if a predecessor is proven invalid while this task is running. (unlikely but possible)
      throw Error('No header for the new block')
    }

    const minersFee = await this.strategy.createMinersFee(
      totalTransactionFees,
      blockHeader.sequence + BigInt(1),
      this._minerAccount.spendingKey,
    )

    return [minersFee, blockTransactions]
  }

  /**
   * Construct a new block and send it out to miners.
   *
   * This is called both when the chain head changes and
   * when the timeout for mining a block at its current difficulty
   * expires.
   *
   * @param newChainHead The hash of the new head of the chain
   * @returns a promise that resolves to a boolean. Boolean returns
   * true if mining that block can be retried with a lower difficulty
   */
  async constructAndMineBlock(minersFee: T, blockTransactions: T[]): Promise<boolean> {
    let newBlock
    try {
      const graffiti = Buffer.alloc(32)
      graffiti.write(this.blockGraffiti)

      newBlock = await this.captain.chain.newBlock(blockTransactions, minersFee, graffiti)
    } catch (e: unknown) {
      const message = (e as { message?: string }).message
      throw Error(`newBlock produced an invalid block: ${message || ''}`)
    }
    this.logger.debug(
      `Current block  ${newBlock.header.sequence}, has ${newBlock.transactions.length} transactions`,
    )

    // For mining, we want a serialized form of the header without the randomness on it
    const target = newBlock.header.target
    this.logger.debug('target set to', target.asBigInt())
    const asBuffer = newBlock.header.serializePartial()
    this.miningRequestId++

    this.logger.debug(
      `Emitting a new block ${newBlock.header.sequence} to mine as request ${this.miningRequestId}`,
    )
    await this.onBlockToMine.emitAsync({
      bytes: asBuffer,
      target,
      miningRequestId: this.miningRequestId,
    })
    this.recentBlocks.set(this.miningRequestId, newBlock)

    const canRetry = target.asBigInt() < Target.maxTarget().asBigInt()
    return canRetry
  }

  /**
   * Called when a block has been successfully mined.
   *
   * To reduce cost of communication with miners, only the randomness for
   * the new block is passed in. It is set on the block we have stored locally
   * and verified.
   *
   * The new block is added to the chain and sent out to be gossip'd.
   *
   * @param randomness The randomness to be set for the new block
   */
  async successfullyMined(randomness: number, miningRequestId: number): Promise<void> {
    const block = this.recentBlocks.get(miningRequestId)
    if (!block) {
      this.logger.debug(
        'Received randomness for a block with unknown request ID (it may have expired)',
      )
      return
    }

    block.header.randomness = randomness
    const validation = await this.captain.chain.verifier.verifyBlock(block)
    if (!validation.valid) {
      this.logger.warn('Discarding invalid block', validation.reason)
      return
    }

    this.logger.info(
      `Successful block ${block.header.sequence} has ${block.transactions.length} transactions`,
    )
    this.logger.info(
      `Propagating successfully mined block ${block.header.sequence}`,
      block.header.hash,
    )
    const header = block.header
    submitMetric({
      name: 'minedBlock',
      fields: [
        { name: 'difficulty', type: 'integer', value: Number(header.target.toDifficulty()) },
        { name: 'sequence', type: 'integer', value: Number(header.sequence) },
      ],
    })

    void this.captain.chain.addBlock(block)
    this.captain.emitBlock(block)
  }

  /**
   * clears the timeout to queue up more mining jobs with recalculated target
   */
  shutdown(): void {
    this.setState({ type: 'STOPPED' })

    if (this.miningDifficultyChangeTimeout) {
      clearTimeout(this.miningDifficultyChangeTimeout)
    }
  }
}

export default MiningDirector
