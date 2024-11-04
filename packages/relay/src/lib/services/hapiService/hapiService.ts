/*-
 *
 * Hedera JSON RPC Relay
 *
 * Copyright (C) 2022-2024 Hedera Hashgraph, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import dotenv from 'dotenv';
import { Logger } from 'pino';
import EventEmitter from 'events';
import findConfig from 'find-config';
import constants from '../../constants';
import { Utils } from './../../../utils';
import { Counter, Registry } from 'prom-client';
import { SDKClient } from '../../clients/sdkClient';
import { HbarLimitService } from '../hbarLimitService';
import { CacheService } from '../cacheService/cacheService';
import { AccountId, Client, PrivateKey } from '@hashgraph/sdk';
import fs from 'fs';
import { ConfigService } from '@hashgraph/json-rpc-config-service/dist/services';

export default class HAPIService {
  /**
   * The number of transactions that have occurred.
   * @private
   * @type {number}
   */
  private transactionCount: number;

  /**
   * An array of error codes encountered.
   * @private
   * @readonly
   * @type {number[]}
   */
  private readonly errorCodes: number[];

  /**
   * The duration for resetting operations.
   * @private
   * @type {number}
   */
  private resetDuration: number;

  /**
   * Indicates whether a reset operation should occur.
   * @private
   * @type {boolean}
   */
  private shouldReset: boolean;

  /**
   * Indicates whether reinitialization is enabled.
   * @private
   * @readonly
   * @type {boolean}
   */
  private readonly isReinitEnabled: boolean;

  /**
   * Indicates whether time-based resets are disabled.
   * @private
   * @readonly
   * @type {boolean}
   */
  private readonly isTimeResetDisabled: boolean;

  /**
   * The initial count of transactions.
   * @private
   * @readonly
   * @type {number}
   */
  private readonly initialTransactionCount: number;

  /**
   * The initial array of error codes.
   * @private
   * @readonly
   * @type {number[]}
   */
  private readonly initialErrorCodes: number[];

  /**
   * The initial duration for resetting operations.
   * @private
   * @readonly
   * @type {number}
   */
  private readonly initialResetDuration: number;

  /**
   * The network name for Hedera services.
   * @private
   * @readonly
   * @type {string}
   */
  private readonly hederaNetwork: string;

  /**
   * The main client for interacting with the Hedera network.
   * @private
   * @type {Client}
   */
  private clientMain: Client;

  /**
   * The SDK Client used for connecting to both the consensus nodes and mirror node. The account
   * associated with this client will pay for all operations on the main network.
   * @private
   * @type {SDKClient}
   */
  private client: SDKClient;

  /**
   * The logger used for logging all output from this class.
   * @private
   * @readonly
   * @type {Logger}
   */
  private readonly logger: Logger;

  /**
   * An instance of the HbarLimitService that tracks hbar expenses and limits.
   * @private
   * @readonly
   * @type {HbarLimitService}
   */
  private readonly hbarLimitService: HbarLimitService;
  /**
   * An instance of EventEmitter used for emitting and handling events within the class.
   * @private
   * @readonly
   * @type {EventEmitter}
   */
  private readonly eventEmitter: EventEmitter;

  /**
   * A registry used within the class.
   * @private
   * @readonly
   * @type {Registry}
   */
  private readonly register: Registry;

  /**
   * A counter for tracking client resets.
   * @private
   * @readonly
   * @type {Counter}
   */
  private readonly clientResetCounter: Counter;

  /**
   * A service for caching data within the class.
   * @private
   * @readonly
   * @type {CacheService}
   */
  private readonly cacheService: CacheService;

  /**
   * @private
   */
  private config: any;

  /**
   * Constructs an instance of the class, initializes configuration settings, and sets up various services.
   *
   * @param {Logger} logger - The logger instance used for logging.
   * @param {Registry} register - The registry instance for metrics and other services.
   * @param {CacheService} cacheService - The cache service instance.
   * @param {EventEmitter} eventEmitter - The event emitter instance used for emitting events.
   * @param {HbarLimitService} hbarLimitService - An HBAR Rate Limit service that tracks hbar expenses and limits.
   */
  constructor(
    logger: Logger,
    register: Registry,
    cacheService: CacheService,
    eventEmitter: EventEmitter,
    hbarLimitService: HbarLimitService,
  ) {
    dotenv.config({ path: findConfig('.env') || '' });
    if (fs.existsSync(findConfig('.env') || '')) {
      this.config = dotenv.parse(fs.readFileSync(findConfig('.env') || ''));
    } else {
      this.config = {};
    }

    this.logger = logger;

    this.hbarLimitService = hbarLimitService;
    this.eventEmitter = eventEmitter;
    this.hederaNetwork = (ConfigService.get('HEDERA_NETWORK') || this.config.HEDERA_NETWORK || '{}').toLowerCase();
    this.clientMain = this.initClient(logger, this.hederaNetwork);

    this.cacheService = cacheService;
    this.client = this.initSDKClient(logger, register);

    const currentDateNow = Date.now();
    // @ts-ignore
    this.initialTransactionCount = parseInt(ConfigService.get('HAPI_CLIENT_TRANSACTION_RESET')!) || 0;
    // @ts-ignore
    this.initialResetDuration = parseInt(ConfigService.get('HAPI_CLIENT_DURATION_RESET')!) || 0;
    // @ts-ignore
    this.initialErrorCodes = JSON.parse(ConfigService.get('HAPI_CLIENT_ERROR_RESET') || '[21, 50]');

    this.transactionCount = this.initialTransactionCount;
    this.resetDuration = currentDateNow + this.initialResetDuration;
    this.errorCodes = this.initialErrorCodes;

    this.isReinitEnabled = true;
    this.isTimeResetDisabled = this.resetDuration === currentDateNow;

    if (this.transactionCount === 0 && this.errorCodes.length === 0 && this.isTimeResetDisabled) {
      this.isReinitEnabled = false;
    }
    this.shouldReset = false;

    this.register = register;
    const metricCounterName = 'rpc_relay_client_service';
    this.register.removeSingleMetric(metricCounterName);
    this.clientResetCounter = new Counter({
      name: metricCounterName,
      help: 'Relay Client Service',
      registers: [register],
      labelNames: ['transactions', 'duration', 'errors'],
    });
  }

  /**
   *  Decrement transaction counter. If 0 is reached, reset the client. Check also if resetDuration has been reached and reset the client, if yes.
   */
  private decrementTransactionCounter() {
    if (this.transactionCount == 0) {
      return;
    }

    this.transactionCount--;
    if (this.transactionCount <= 0) {
      this.shouldReset = true;
    }
  }

  /**
   *  Decrement error encountered counter. If 0 is reached, reset the client. Check also if resetDuration has been reached and reset the client, if yes.
   */
  public decrementErrorCounter(statusCode: number) {
    if (!this.isReinitEnabled || this.errorCodes.length === 0) {
      return;
    }

    if (this.errorCodes.includes(statusCode)) {
      this.shouldReset = true;
    }
  }

  private checkResetDuration() {
    if (this.isTimeResetDisabled) {
      return;
    }

    if (this.resetDuration < Date.now()) {
      this.shouldReset = true;
    }
  }

  /**
   * Reset the SDK Client and all counters.
   */
  private resetClient() {
    this.clientResetCounter
      .labels(this.transactionCount.toString(), this.resetDuration.toString(), this.errorCodes.toString())
      .inc(1);

    this.clientMain = this.initClient(this.logger, this.hederaNetwork);
    this.client = this.initSDKClient(this.logger, this.register);
    this.resetCounters();
  }

  /**
   * Reset all counters with predefined configuration.
   */
  private resetCounters() {
    this.transactionCount = this.initialTransactionCount;
    this.resetDuration = Date.now() + this.initialResetDuration;

    this.shouldReset = false;
  }

  /**
   * Configure SDK Client from main client
   * @param {Logger} logger
   * @returns SDK Client
   */
  private initSDKClient(logger: Logger, register: Registry): SDKClient {
    return new SDKClient(
      this.clientMain,
      logger.child({ name: `consensus-node` }),
      this.cacheService,
      this.eventEmitter,
      this.hbarLimitService,
      register,
    );
  }

  /**
   * Configure Client
   * @param {Logger} logger
   * @param {string} hederaNetwork
   * @param {string | null} type
   * @returns Client
   */
  private initClient(logger: Logger, hederaNetwork: string, type: string | null = null): Client {
    let client: Client, privateKey: PrivateKey;
    if (hederaNetwork in constants.CHAIN_IDS) {
      client = Client.forName(hederaNetwork);
    } else {
      client = Client.forNetwork(JSON.parse(hederaNetwork));
    }

    if (type === 'eth_sendRawTransaction') {
      if (
        ConfigService.get('OPERATOR_ID_ETH_SENDRAWTRANSACTION') &&
        ConfigService.get('OPERATOR_KEY_ETH_SENDRAWTRANSACTION')
      ) {
        // @ts-ignore
        privateKey = Utils.createPrivateKeyBasedOnFormat(ConfigService.get('OPERATOR_KEY_ETH_SENDRAWTRANSACTION'));
        client = client.setOperator(
          // @ts-ignore
          AccountId.fromString(ConfigService.get('OPERATOR_ID_ETH_SENDRAWTRANSACTION')),
          privateKey,
        );
      } else {
        logger.warn(`Invalid 'ETH_SENDRAWTRANSACTION' env variables provided`);
      }
    } else {
      const operatorId: string = ConfigService.get('OPERATOR_ID_MAIN') || this.config.OPERATOR_ID_MAIN || '';
      const operatorKey: string = ConfigService.get('OPERATOR_KEY_MAIN') || this.config.OPERATOR_KEY_MAIN || '';

      if (operatorId && operatorKey) {
        privateKey = Utils.createPrivateKeyBasedOnFormat(operatorKey);
        client = client.setOperator(AccountId.fromString(operatorId.trim()), privateKey);
      } else {
        logger.warn(`Invalid 'OPERATOR' env variables provided`);
      }
    }

    // @ts-ignore
    client.setTransportSecurity(ConfigService.get('CLIENT_TRANSPORT_SECURITY') ?? false);

    // @ts-ignore
    const SDK_REQUEST_TIMEOUT = parseInt(ConfigService.get('SDK_REQUEST_TIMEOUT') || '10000');
    client.setRequestTimeout(SDK_REQUEST_TIMEOUT);

    logger.info(
      `SDK client successfully configured to ${JSON.stringify(hederaNetwork)} for account ${
        client.operatorAccountId
      } with request timeout value: ${SDK_REQUEST_TIMEOUT}`,
    );

    return client;
  }

  /**
   * Return current main client instance
   * @returns Main Client
   */
  public getMainClientInstance() {
    return this.clientMain;
  }

  /**
   * Return configured sdk client and reinitialize it before retuning, if needed.
   * @returns SDK Client
   */
  public getSDKClient(): SDKClient {
    if (!this.isReinitEnabled) {
      return this.client;
    }

    if (this.shouldReset) {
      this.logger.warn(`SDK Client reinitialization.`);
      this.resetClient();
    }
    this.decrementTransactionCounter();
    this.checkResetDuration();

    return this.client;
  }

  /**
   * Return true if reinitialization feature is enabled.
   * @returns isEnabled boolean
   */
  public getIsReinitEnabled() {
    return this.isReinitEnabled;
  }

  /**
   * Return transaction count with current sdk instance.
   * @returns transactionCount
   */
  public getTransactionCount() {
    return this.transactionCount;
  }

  /**
   * Return error codes which can trigger a sdk instance reinitialization.
   * @returns errorCodes
   */
  public getErrorCodes() {
    return this.errorCodes;
  }

  /**
   * Return time until reset of the current sdk instance.
   */
  public getTimeUntilReset() {
    return this.resetDuration - Date.now();
  }
}
