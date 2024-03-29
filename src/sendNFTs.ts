import seedrandom from "seedrandom";
import { params } from "../config.js";
import { BN } from '@polkadot/util';
import { logger } from "../tools/logger.js";
import { pinSingleFileFromDir, pinSingleMetadataWithoutFile, pinSingleWithThumbMetadataFromDir } from "../tools/pinataUtils.js";
import fs from 'fs';
import { Base, Collection, NFT } from "rmrk-tools";
import { u8aToHex } from "@polkadot/util";
import { INftProps, VoteConviction } from "../types.js";
import { getApi, getApiTest, getDecimal, sendBatchTransactions } from "../tools/substrateUtils.js";
import { amountToHumanString, getDragonBonusFile, getSettingsFile, sleep } from "../tools/utils.js";
import { AccountId, VotingDelegating, VotingDirectVote } from "@polkadot/types/interfaces";
import { PalletDemocracyVoteVoting } from "@polkadot/types/lookup";
import { ApiDecoration } from "@polkadot/api/types";
import { encodeAddress } from "@polkadot/util-crypto";
import { nanoid } from "nanoid";
import { IAttribute, IRoyaltyAttribute } from "rmrk-tools/dist/tools/types";
import { createNewCollection } from "./createNewCollection.js";
import { BaseConsolidated } from "rmrk-tools/dist/tools/consolidator/consolidator";
import { objectSpread } from '@polkadot/util';

const extractVotes = (mapped: [AccountId, PalletDemocracyVoteVoting][], referendumId: BN) => {
    return mapped
        .filter(([, voting]) => voting.isDirect)
        .map(([accountId, voting]): [AccountId, VotingDirectVote[]] => [
            accountId,
            voting.asDirect.votes.filter(([idx]) => idx.eq(referendumId))
        ])
        .filter(([, directVotes]) => !!directVotes.length)
        .reduce((result: VoteConviction[], [accountId, votes]) =>
            // FIXME We are ignoring split votes
            votes.reduce((result: VoteConviction[], [, vote]): VoteConviction[] => {
                if (vote.isStandard) {
                    result.push(
                        objectSpread({
                            accountId,
                            isDelegating: false
                        }, vote.asStandard)
                    );

                }

                return result;
            }, result), []
        );
}

const votesCurr = async (api: ApiDecoration<"promise">, referendumId: BN, atExpiry: Boolean, passed: Boolean) => {
    const allVoting = await api.query.democracy.votingOf.entries()
    //logger.info("allVoting", allVoting)
    const mapped = allVoting.map(([{ args: [accountId] }, voting]): [AccountId, PalletDemocracyVoteVoting] => [accountId, voting]);
    let votes: VoteConviction[] = extractVotes(mapped, referendumId);
    const delegations = mapped
        .filter(([, voting]) => voting.isDelegating)
        .map(([accountId, voting]): [AccountId, VotingDelegating] => [accountId, voting.asDelegating]);

    // add delegations
    delegations.forEach(([accountId, { balance, conviction, target }]): void => {
        // Are we delegating to a delegator
        const toDelegator = delegations.find(([accountId]) => accountId.eq(target));
        const to = votes.find(({ accountId }) => accountId.eq(toDelegator ? toDelegator[0] : target));

        // this delegation has a target
        if (to) {
            votes.push({
                accountId,
                balance,
                isDelegating: true,
                vote: api.registry.createType('Vote', { aye: to.vote.isAye, conviction })
            });
        }
    });
    const LOCKS = [1, 10, 20, 30, 40, 50, 60];
    if (atExpiry) {
        votes = votes.map((vote) => {
            const convictionBalance = vote.balance.muln(LOCKS[vote.vote.conviction.toNumber()]).div(new BN(10)).toString();
            return { ...vote, convictionBalance }
        })
    }
    else {
        votes = votes.map((vote) => {
            let convictionBalance;
            //only consider conviction when tokens are actually locked up => when vote is in line with ref outcome
            if ((vote.vote.isAye && passed) || (!vote.vote.isAye && !passed)){
                convictionBalance = vote.balance.muln(LOCKS[vote.vote.conviction.toNumber()]).div(new BN(10)).toString();
            }
            else {
                //immediately unlocked => conviction multiplier = 0.1
                convictionBalance = vote.balance.muln(LOCKS[0]).div(new BN(10)).toString();
            }
            return { ...vote, convictionBalance }
        })
    }
    return votes;
}

const filterVotes = async (referendumId: BN, votes: VoteConviction[], totalIssuance: string, settings): Promise<VoteConviction[]> => {
    const minVote = BN.max(new BN(settings.min), new BN("0"));
    const maxVote = BN.min(new BN(settings.max), new BN(totalIssuance));
    logger.info("min:", minVote.toString());
    logger.info("minHuman:", await amountToHumanString(minVote.toString()))
    logger.info("max:", maxVote.toString());
    logger.info("maxHuman:", await amountToHumanString(maxVote.toString()))
    let filtered = votes.filter((vote) => {
        return (new BN(vote.convictionBalance).gte(minVote) &&
            new BN(vote.convictionBalance).lte(maxVote))
    })
    if (settings.directOnly) {
        filtered = votes.filter((vote) => !vote.isDelegating)
    }
    if (settings.first !== "-1") {
        return filtered.slice(0, parseInt(settings.first))
    }
    return filtered
}

const getVotesAndIssuance = async (referendumIndex: BN, atExpiry: boolean, passed, settings?): Promise<[String, VoteConviction[]]> => {
    const api = await getApi();
    const info = await api.query.democracy.referendumInfoOf(referendumIndex);

    let blockNumber: BN;
    try {
        blockNumber = info.unwrap().asFinished.end
    }
    catch (e) {
        logger.error(`Referendum is still ongoing: ${e}`);
        return;
    }

    let cutOffBlock;
    if (!atExpiry) {
        cutOffBlock = settings.blockCutOff && settings.blockCutOff !== "-1" ?
            settings.blockCutOff : blockNumber
        logger.info("Cut-off Block: ", cutOffBlock.toString())
    }
    else {
        cutOffBlock = blockNumber
    }
    const blockHash = await api.rpc.chain.getBlockHash(cutOffBlock);
    const blockApi = await api.at(blockHash);
    const totalIssuance = (await blockApi.query.balances.totalIssuance()).toString()
    return [totalIssuance, await votesCurr(blockApi, referendumIndex, atExpiry, passed)];
}

const getShelflessAccounts = async (votes: VoteConviction[], collectionId): Promise<AccountId[]> => {
    let accounts: AccountId[] = [];
    for (const vote of votes) {
        let allNFTs = await params.remarkStorageAdapter.getNFTsByCollection(collectionId);
        if (!allNFTs.find(({ owner, rootowner, symbol, burned }) => {
            return rootowner === vote.accountId.toString() &&
                symbol === params.settings.shelfNFTSymbol &&
                burned === ""
        })) {
            accounts.push(vote.accountId)
        }
    }
    return accounts;
}

const getRandom = (rng, weights) => {
    var num = rng(),
        s = 0,
        lastIndex = weights.length - 1;
    for (var i = 0; i < lastIndex; ++i) {
        s += weights[i];
        if (num < s) {
            return i;
        }
    }

    return lastIndex;
};



const calculateLuck = async (n, minIn, maxIn, minOut, maxOut, exponent, babyWallets, toddlerWallets, adolescentWallets, adultWallets, account, babyBonus, toddlerBonus, adolescentBonus, adultBonus, minAmount) => {

    n = await getDecimal(n);
    minOut = parseInt(minOut);
    maxOut = parseInt(maxOut);
    if (n > maxIn) {
        n = maxOut;
    }
    else if (n < minAmount) {
        n = minOut;
    }
    else {
        // unscale input
        n -= minIn
        n /= maxIn - minIn
        n = Math.pow(n, exponent)
        // scale output
        n *= maxOut - minOut
        n += minOut

    }
    //check if dragon bonus
    if (adultWallets.includes(account)) {
        n = n * (1 + (adultBonus / 100))
    }
    else if (adolescentWallets.includes(account)) {
        n = n * (1 + (adolescentBonus / 100))
    }
    else if (toddlerWallets.includes(account)) {
        n = n * (1 + (toddlerBonus / 100))
    }
    else if (babyWallets.includes(account)) {
        n = n * (1 + (babyBonus / 100))
    }
    return n
}

const getMinMaxMedian = (someArray, criticalValue) => {
    if (someArray.length < 4)
        return someArray;
    someArray = someArray.filter(vote => {
        return vote > criticalValue
    })

    let values, q1, q3, iqr, maxValue, minValue, median;

    values = someArray.slice().sort((a, b) => a - b);//copy array fast and sort
    if ((values.length / 4) % 1 === 0) {//find quartiles
        q1 = 1 / 2 * (values[(values.length / 4)] + values[(values.length / 4) + 1]);
        q3 = 1 / 2 * (values[(values.length * (3 / 4))] + values[(values.length * (3 / 4)) + 1]);
    } else {
        q1 = values[Math.floor(values.length / 4 + 1)];
        q3 = values[Math.ceil(values.length * (3 / 4) + 1)];
    }

    if ((values.length / 2) % 1 === 0) {//find quartiles
        median = 1 / 2 * (values[(values.length / 2)] + values[(values.length / 2) + 1]);
    } else {
        median = values[Math.floor(values.length / 2 + 1)];
    }
    logger.info("q1", q1);
    logger.info("q3", q3);
    logger.info("median", median);
    iqr = q3 - q1;
    maxValue = q3 + iqr * 1.5;
    minValue = q1 - iqr * 1.5;
    logger.info("maxi", maxValue);
    logger.info("mini", minValue);
    return { minValue, maxValue, median };
}

export const sendNFTs = async (passed: boolean, referendumIndex: BN, indexer = null) => {
    //wait a bit since blocks after will be pretty full
    await sleep(10000);
    let api = await getApi();
    //wait until remark block has caught up with block
    let currentFinalized = (await api.rpc.chain.getBlock(await api.rpc.chain.getFinalizedHead())).block.header.number.toNumber()
    if (params.settings.isTest) {
        api = await getApiTest();
    }
    while ((await params.remarkBlockCountAdapter.get()) < currentFinalized) {
        logger.info(`waiting for remark (Block: ${await params.remarkBlockCountAdapter.get()}) to get to current block: ${currentFinalized}`);
        await sleep(3000);
        currentFinalized = (await api.rpc.chain.getBlock(await api.rpc.chain.getFinalizedHead())).block.header.number.toNumber()
    }
    let votes: VoteConviction[] = [];
    let totalIssuance: String;
    let totalVotes: VoteConviction[];
    let totalIssuanceRefExpiry: String;
    const chunkSize = params.settings.chunkSize;
    const chunkSizeDefault = params.settings.chunkSizeDefault;
    const chunkSizeShelf = params.settings.chunkSizeShelf;

    [totalIssuanceRefExpiry, totalVotes] = await getVotesAndIssuance(referendumIndex, true, passed)
    logger.info("Number of votes: ", totalVotes.length)

    let settingsFile = await getSettingsFile(referendumIndex);
    if (settingsFile === "") {
        return;
    }
    let settings = await JSON.parse(settingsFile);
    const rng = seedrandom(referendumIndex.toString() + settings.seed);
    let bonusFile = await getDragonBonusFile(referendumIndex);
    if (bonusFile === "") {
        return;
    }
    let bonuses = await JSON.parse(bonusFile);
    //check that bonusFile is from correct block
    if (bonuses.block != indexer.blockHeight) {
        logger.info(`Wrong Block in Bonus File. Exiting.`);
        return;
    }
    const babyDragons = bonuses.babies;
    const toddlerDragons = bonuses.toddlers;
    const adolescentDragons = bonuses.adolescents;
    const adultDragons = bonuses.adults;
    const babyWallets = babyDragons.map(({ wallet }) => wallet);
    const toddlerWallets = toddlerDragons.map(({ wallet }) => wallet);
    const adolescentWallets = adolescentDragons.map(({ wallet }) => wallet);
    const adultWallets = adultDragons.map(({ wallet }) => wallet);
    [totalIssuance, votes] = await getVotesAndIssuance(referendumIndex, false, passed, settings);

    // fs.writeFile(`assets/shelf/votes/${referendumIndex}.txt`, JSON.stringify(totalVotes), (err) => {

    //     // In case of a error throw err.
    //     if (err) throw err;
    // })
    // // for testing only
    // let data = await fs.readFileSync(`assets/shelf/votes/${referendumIndex}.txt`).toString('utf-8')
    // let data2 = JSON.parse(data)
    // for (const vote of data2) {
    //     let new1 = vote as unknown;
    //     let new2 = new1 as VoteConviction;
    //     votes.push(new2)
    // }
    // console.log(votes)


    const shelfRoyaltyProperty: IRoyaltyAttribute = {
        type: "royalty",
        value: {
            receiver: encodeAddress(params.account.address, params.settings.network.prefix),
            royaltyPercentFloat: 90
        }
    }
    // // for testing only
    // totalIssuance = "12312312312342312314"
    const filteredVotes = await filterVotes(referendumIndex, votes, totalIssuance.toString(), settings)
    logger.info("Number of votes after filter: ", filteredVotes.length)

    //get votes not in filtered
    const votesNotMeetingRequirements = votes.filter(vote => {
        return !filteredVotes.some(o => {
            return o.accountId.toString() === vote.accountId.toString()
                && o.vote.toString() === vote.vote.toString()
                && o.isDelegating === vote.isDelegating
        });
    })

    logger.info(`${votesNotMeetingRequirements.length} votes not meeting the requirements.`)

    let luckArray = [];
    const minVote = filteredVotes.reduce((prev, curr) => new BN(prev.convictionBalance).lt(new BN(curr.convictionBalance)) ? prev : curr);
    const maxVote = filteredVotes.reduce((prev, curr) => new BN(prev.convictionBalance).gt(new BN(curr.convictionBalance)) ? prev : curr);
    logger.info("minVote", minVote.convictionBalance.toString())
    logger.info("maxVote", maxVote.convictionBalance.toString())
    const promises = filteredVotes.map(async (vote) => {
        return await getDecimal(vote.convictionBalance.toString())
    })
    const voteAmounts = await Promise.all(promises);
    let { minValue, maxValue, median } = getMinMaxMedian(voteAmounts, settings.minAmount)
    await sleep(10000);
    minValue = minValue < await getDecimal(minVote.convictionBalance.toString()) ? await getDecimal(minVote.convictionBalance.toString()) : minValue

    let selectedIndexArray = [];
    for (const vote of filteredVotes) {
        let luck;
        let selectedIndex;
        let counter = 0;
        for (const option of settings.options) {
            if (counter < settings.options.length - 1) {
                if (await getDecimal(vote.convictionBalance.toString()) < median) {
                    // if (await getDecimal(vote.convictionBalance.toString()) < settings.minAmount) {
                    //     luck = option.minProbability;
                    // }
                    // else {
                    luck = await calculateLuck(vote.convictionBalance.toString(),
                        minValue,
                        median,
                        option.minProbability,
                        option.sweetspotProbability,
                        3,
                        babyWallets,
                        toddlerWallets,
                        adolescentWallets,
                        adultWallets,
                        vote.accountId.toString(),
                        settings.babyBonus,
                        settings.toddlerBonus,
                        settings.adolescentBonus,
                        settings.adultBonus,
                        settings.minAmount)
                    // }
                }
                else {
                    // if (await getDecimal(vote.convictionBalance.toString()) > maxValue) {
                    //     luck = option.maxProbability;
                    // }
                    // else {
                    luck = await calculateLuck(vote.convictionBalance.toString(),
                        median,
                        maxValue,
                        option.sweetspotProbability,
                        option.maxProbability,
                        0.4,
                        babyWallets,
                        toddlerWallets,
                        adolescentWallets,
                        adultWallets,
                        vote.accountId.toString(),
                        settings.babyBonus,
                        settings.toddlerBonus,
                        settings.adolescentBonus,
                        settings.adultBonus,
                        settings.minAmount)
                    // }
                }
                selectedIndex = getRandom(rng, [luck / 100, (100 - luck) / 100]);
                if (selectedIndex === 0) {
                    selectedIndex = counter;
                    break;
                }
            }
            selectedIndex = counter;
            counter++;
        }
        luckArray.push([vote.convictionBalance.toString(), luck, selectedIndex, vote.accountId.toString()])
        selectedIndexArray.push(selectedIndex)
    }
    var uniqs = selectedIndexArray.reduce((acc, val) => {
        acc[val] = acc[val] === undefined ? 1 : acc[val] += 1;
        return acc;
    }, {});
    var commonIndex = Object.keys(uniqs).sort().pop();
    console.log("commonIndex", commonIndex)
    uniqs[commonIndex] = uniqs[commonIndex] + votesNotMeetingRequirements.length

    logger.info(uniqs)
    for (const vote of votesNotMeetingRequirements) {
        luckArray.push([vote.convictionBalance.toString(), 0, parseInt(commonIndex), vote.accountId.toString()])
    }

    fs.writeFile(`assets/shelf/luck/${referendumIndex}.txt`, JSON.stringify(luckArray), (err) => {

        // In case of a error throw err.
        if (err) throw err;
    })

    const shelfCollectionId = Collection.generateId(
        u8aToHex(params.account.publicKey),
        params.settings.parentCollectionSymbol
    );

    let itemCollectionId;
    //create collection if required

    if (settings.createNewCollection) {
        itemCollectionId = Collection.generateId(
            u8aToHex(params.account.publicKey),
            settings.newCollectionSymbol
        );
        let collection = await params.remarkStorageAdapter.getCollectionById(itemCollectionId);
        if (!collection) {
            await createNewCollection(itemCollectionId, settings);
        }
        else {
            logger.info("New collection already exists.")
        }
    }
    else {
        itemCollectionId = Collection.generateId(
            u8aToHex(params.account.publicKey),
            params.settings.itemCollectionSymbol
        );
    }
    logger.info("collectionID Item: ", itemCollectionId)

    await sleep(10000);

    // //remove this
    // totalVotes = votes;

    //check which wallets don't have the shelf nft
    const accountsWithoutShelf: AccountId[] = await getShelflessAccounts(totalVotes, shelfCollectionId)
    //send shelf to wallets that don't have one yet
    if (accountsWithoutShelf.length > 0) {
        //upload shelf to pinata
        const [shelfMetadataCid, shelfMainCid, shelfThumbCid] = await pinSingleWithThumbMetadataFromDir("/assets",
            "shelf/shelf.png",
            `Your Shelf`,
            {
                description: `Each time you vote on a referendum, a new item will be added to this shelf.`,
                properties: {},
            },
            "shelf/shelf_thumb.png"
        );
        await sleep(2000);
        if (!shelfMetadataCid) {
            logger.error(`parentMetadataCid is null: ${shelfMetadataCid}. exiting.`)
            return;
        }
        //get base
        const bases = await params.remarkStorageAdapter.getAllBases();
        const baseId = bases.find(({ issuer, symbol }) => {
            return issuer === encodeAddress(params.account.address, params.settings.network.prefix).toString() &&
                symbol === params.settings.baseSymbol
        }).id
        logger.info("baseId: ", baseId)

        let chunkCount = 0
        logger.info("accountsWithoutShelf", accountsWithoutShelf.length)
        for (let i = 0; i < accountsWithoutShelf.length; i += chunkSizeShelf) {
            const shelfRemarks: string[] = [];
            const chunk = accountsWithoutShelf.slice(i, i + chunkSizeShelf);
            logger.info(`Chunk ${chunkCount}: ${chunk.length}`)
            let count = 0
            for (const account of chunk) {

                const nftProps: INftProps = {
                    block: 0,
                    sn: ('00000000' + ((chunkCount * chunkSizeShelf) + count++).toString()).slice(-8),
                    owner: encodeAddress(params.account.address, params.settings.network.prefix),
                    transferable: 1,
                    metadata: shelfMetadataCid,
                    collection: shelfCollectionId,
                    symbol: params.settings.shelfNFTSymbol,
                    properties: {
                        royaltyInfo: {
                            ...shelfRoyaltyProperty
                        }
                    }
                };
                const nft = new NFT(nftProps);
                if (params.settings.isTest && (account.toString() === "FF4KRpru9a1r2nfWeLmZRk6N8z165btsWYaWvqaVgR6qVic"
                    || account.toString() === "D3iNikJw3cPq6SasyQCy3k4Y77ZeecgdweTWoSegomHznG3"
                    || account.toString() === "HWP8QiZRs3tVbHUFJwA4NANgCx2HbbSSsevgJWhHJaGNLeV"
                    || account.toString() === "D2v2HoA6Kgd4czRT3Yo1uUq6XYntAk81GuYpCgVNjmZaETK")) {
                    shelfRemarks.push(nft.mint());
                }
                else if (!params.settings.isTest) {
                    shelfRemarks.push(nft.mint());
                }
            }
            logger.info("shelfRemarks", JSON.stringify(shelfRemarks))
            if (shelfRemarks.length > 0) {
                const { block, success, hash, fee } = await sendBatchTransactions(shelfRemarks);
                logger.info(`Shelf NFTs minted at block ${block}: ${success} for a total fee of ${fee}`)
                //wait until remark block has caught up with block
                while ((await params.remarkBlockCountAdapter.get()) < block) {
                    await sleep(3000);
                }
                await sleep(60000);
                // add base resource to shelf nfts
                const addBaseRemarks: string[] = [];

                count = 0;
                for (const account of chunk) {

                    const nftProps: INftProps = {
                        block: block,
                        sn: ('00000000' + ((chunkCount * chunkSizeShelf) + count++).toString()).slice(-8),
                        owner: encodeAddress(params.account.address, params.settings.network.prefix),
                        transferable: 1,
                        metadata: shelfMetadataCid,
                        collection: shelfCollectionId,
                        symbol: params.settings.shelfNFTSymbol,
                    };
                    const nft = new NFT(nftProps);
                    let parts = [];
                    parts.push("background");
                    parts.push("shelf");
                    parts.push("decoration");
                    for (let i = params.settings.startReferendum; i <= params.settings.startReferendum + params.settings.itemCount; i++) {
                        parts.push(`REFERENDUM_${i.toString()}`)
                    }
                    parts.push("foreground");
                    if (params.settings.isTest && (account.toString() === "FF4KRpru9a1r2nfWeLmZRk6N8z165btsWYaWvqaVgR6qVic"
                        || account.toString() === "D3iNikJw3cPq6SasyQCy3k4Y77ZeecgdweTWoSegomHznG3"
                        || account.toString() === "HWP8QiZRs3tVbHUFJwA4NANgCx2HbbSSsevgJWhHJaGNLeV"
                        || account.toString() === "D2v2HoA6Kgd4czRT3Yo1uUq6XYntAk81GuYpCgVNjmZaETK")) {
                        addBaseRemarks.push(
                            nft.resadd({
                                base: baseId,
                                id: nanoid(16),
                                parts: parts,
                                thumb: `ipfs://ipfs/${shelfThumbCid}`,
                            })
                        );
                    }
                    else if (!params.settings.isTest) {
                        addBaseRemarks.push(
                            nft.resadd({
                                base: baseId,
                                id: nanoid(16),
                                parts: parts,
                                thumb: `ipfs://ipfs/${shelfThumbCid}`,
                            })
                        );
                    }
                }
                logger.info("addBaseRemarks: ", JSON.stringify(addBaseRemarks))
                // split remarks into sets of 400?
                const { block: addBaseBlock, success: addBaseSuccess, hash: addBaseHash, fee: addBaseFee } = await sendBatchTransactions(addBaseRemarks);
                logger.info(`Base added at block ${addBaseBlock}: ${addBaseSuccess} for a total fee of ${addBaseFee}`)
                while ((await params.remarkBlockCountAdapter.get()) < addBaseBlock) {
                    await sleep(3000);
                }
                await sleep(60000);

                // send out shelf nfts
                const sendRemarks: string[] = [];

                count = 0;
                for (const account of chunk) {

                    const nftProps: INftProps = {
                        block: block,
                        sn: ('00000000' + ((chunkCount * chunkSizeShelf) + count++).toString()).slice(-8),
                        owner: encodeAddress(params.account.address, params.settings.network.prefix),
                        transferable: 1,
                        metadata: shelfMetadataCid,
                        collection: shelfCollectionId,
                        symbol: params.settings.shelfNFTSymbol,
                    };
                    const nft = new NFT(nftProps);
                    if (params.settings.isTest && (account.toString() === "FF4KRpru9a1r2nfWeLmZRk6N8z165btsWYaWvqaVgR6qVic"
                        || account.toString() === "D3iNikJw3cPq6SasyQCy3k4Y77ZeecgdweTWoSegomHznG3"
                        || account.toString() === "HWP8QiZRs3tVbHUFJwA4NANgCx2HbbSSsevgJWhHJaGNLeV"
                        || account.toString() === "D2v2HoA6Kgd4czRT3Yo1uUq6XYntAk81GuYpCgVNjmZaETK")) {
                        sendRemarks.push(nft.send(account.toString()))
                    }
                    else if (!params.settings.isTest) {
                        sendRemarks.push(nft.send(account.toString()))
                    }
                }

                logger.info("sendRemarks: ", JSON.stringify(sendRemarks))
                const { block: sendBlock, success: sendSuccess, hash: sendHash, fee: sendFee } = await sendBatchTransactions(sendRemarks);
                logger.info(`NFTs sent at block ${sendBlock}: ${sendSuccess} for a total fee of ${sendFee}`)

                while ((await params.remarkBlockCountAdapter.get()) < sendBlock) {
                    await sleep(3000);
                }
                await sleep(60000);
            }
            chunkCount++;
        }

    }
    await sleep(3000);
    let allNFTs = await params.remarkStorageAdapter.getNFTsByCollection(shelfCollectionId);

    const withoutSend = allNFTs.filter(({ changes, symbol, burned }) => {
        return changes.length === 0 &&
            symbol === params.settings.shelfNFTSymbol &&
            burned === ""
    })

    if (withoutSend && withoutSend.length > 0) {
        logger.error(`${withoutSend.length} send transactions not registered: ${JSON.stringify(withoutSend)}. Exiting...`)
        return;
    }


    const rarityAttribute: IAttribute = {
        type: "string",
        value: settings.default.rarity,
    }
    const supplyAttribute: IAttribute = {
        type: "number",
        value: uniqs[commonIndex],
    }
    const artistAttribute: IAttribute = {
        type: "string",
        value: settings.default.artist,
    }
    const creativeDirectorAttribute: IAttribute = {
        type: "string",
        value: settings.default.creativeDirector,
    }
    const refIndexAttribute: IAttribute = {
        type: "string",
        value: referendumIndex.toString(),
    }
    const nameAttribute: IAttribute = {
        type: "string",
        value: settings.default.itemName,
    }
    const typeOfVoteDirectAttribute: IAttribute = {
        type: "string",
        value: "direct",
    }

    const typeOfVoteDelegatedAttribute: IAttribute = {
        type: "string",
        value: "delegated",
    }
    //send "non-rare" NFT to voters not meeting requirements

    const metadataCidDirectDefault = await pinSingleMetadataWithoutFile(
        `Referendum ${referendumIndex}`,
        {
            description: settings.default.text,
            properties: {
                "rarity": {
                    ...rarityAttribute
                },
                "total_supply": {
                    ...supplyAttribute
                },
                "artist": {
                    ...artistAttribute
                },
                "creative_director": {
                    ...creativeDirectorAttribute
                },
                "referendum_index": {
                    ...refIndexAttribute
                },
                "name": {
                    ...nameAttribute
                },
                "type_of_vote": {
                    ...typeOfVoteDirectAttribute
                }
            }
        }
    );

    const metadataCidDelegatedDefault = await pinSingleMetadataWithoutFile(
        `Referendum ${referendumIndex}`,
        {
            description: settings.default.text,
            properties: {
                "rarity": {
                    ...rarityAttribute
                },
                "total_supply": {
                    ...supplyAttribute
                },
                "artist": {
                    ...artistAttribute
                },
                "creative_director": {
                    ...creativeDirectorAttribute
                },
                "referendum_index": {
                    ...refIndexAttribute
                },
                "name": {
                    ...nameAttribute
                },
                "type_of_vote": {
                    ...typeOfVoteDelegatedAttribute
                }
            }
        }
    );

    if (!metadataCidDirectDefault || !metadataCidDelegatedDefault) {
        logger.error(`one of metadataCids is null: dir: ${metadataCidDirectDefault} del: ${metadataCidDelegatedDefault}. exiting.`)
        return;
    }

    let chunkCount = 0

    let resourceCidsDefault = []

    for (let i = 0; i < settings.default.resources.length; i++) {
        const resource = settings.default.resources[i]
        let mainCid = await pinSingleFileFromDir("/assets/shelf/referenda",
            resource.main,
            resource.name)
        let thumbCid = await pinSingleFileFromDir("/assets/shelf/referenda",
            resource.thumb,
            resource.name + "_thumb")
        resourceCidsDefault.push([mainCid, thumbCid])
    }

    logger.info("resourceCidsDefault", resourceCidsDefault);

    let resourceMetadataCidsDefault = []

    for (let i = 0; i < settings.default.resources.length; i++) {
        const resource = settings.default.resources[i]
        const rarityAttribute: IAttribute = {
            type: "string",
            value: resource.rarity,
        }
        const supplyAttribute: IAttribute = {
            type: "number",
            value: uniqs[commonIndex],
        }
        const artistAttribute: IAttribute = {
            type: "string",
            value: resource.artist,
        }
        const creativeDirectorAttribute: IAttribute = {
            type: "string",
            value: resource.creativeDirector,
        }
        const refIndexAttribute: IAttribute = {
            type: "string",
            value: referendumIndex.toString(),
        }
        const nameAttribute: IAttribute = {
            type: "string",
            value: resource.itemName,
        }
        const metadataResource = await pinSingleMetadataWithoutFile(
            `Referendum ${referendumIndex}`,
            {
                description: resource.text,
                properties: {
                    "rarity": {
                        ...rarityAttribute
                    },
                    "total_supply": {
                        ...supplyAttribute
                    },
                    "artist": {
                        ...artistAttribute
                    },
                    "creative_director": {
                        ...creativeDirectorAttribute
                    },
                    "referendum_index": {
                        ...refIndexAttribute
                    },
                    "name": {
                        ...nameAttribute
                    }
                }
            }
        );
        resourceMetadataCidsDefault.push(metadataResource)
    }

    logger.info("resourceMetadataCidsDefault", resourceMetadataCidsDefault);

    for (let i = 0; i < votesNotMeetingRequirements.length; i += chunkSizeDefault) {
        const chunk = votesNotMeetingRequirements.slice(i, i + chunkSizeDefault);
        logger.info(`Chunk ${chunkCount}: ${chunk.length}`)
        const mintRemarks: string[] = [];
        let usedMetadataCidsDefault: string[] = [];
        let count = 0;
        for (const vote of chunk) {

            let metadataCid = vote.isDelegating ? metadataCidDelegatedDefault : metadataCidDirectDefault

            const randRoyaltyInRange = Math.floor(rng() * (settings.default.royalty[1] - settings.default.royalty[0] + 1) + settings.default.royalty[0])
            const itemRoyaltyProperty: IRoyaltyAttribute = {
                type: "royalty",
                value: {
                    receiver: encodeAddress(params.account.address, params.settings.network.prefix),
                    royaltyPercentFloat: randRoyaltyInRange
                }
            }
            if (!metadataCid) {
                logger.error(`metadataCid is null. exiting.`)
                return;
            }
            const nftProps: INftProps = {
                block: 0,
                sn: ('00000000' + ((chunkCount * chunkSizeDefault) + count++).toString()).slice(-8),
                owner: encodeAddress(params.account.address, params.settings.network.prefix),
                transferable: 1, //parseInt(selectedOption.transferable)
                metadata: metadataCid,
                collection: itemCollectionId,
                symbol: referendumIndex.toString() + settings.default.symbol,
                properties: {
                    royaltyInfo: {
                        ...itemRoyaltyProperty
                    }
                },
            };
            usedMetadataCidsDefault.push(metadataCid);
            const nft = new NFT(nftProps);
            if (params.settings.isTest && (vote.accountId.toString() === "FF4KRpru9a1r2nfWeLmZRk6N8z165btsWYaWvqaVgR6qVic"
                || vote.accountId.toString() === "D3iNikJw3cPq6SasyQCy3k4Y77ZeecgdweTWoSegomHznG3"
                || vote.accountId.toString() === "HWP8QiZRs3tVbHUFJwA4NANgCx2HbbSSsevgJWhHJaGNLeV"
                || vote.accountId.toString() === "D2v2HoA6Kgd4czRT3Yo1uUq6XYntAk81GuYpCgVNjmZaETK")) {
                mintRemarks.push(nft.mint());
            }
            else if (!params.settings.isTest) {
                mintRemarks.push(nft.mint());
            }
        }
        logger.info("mintRemarksDefault: ", JSON.stringify(mintRemarks))
        //mint
        if (mintRemarks.length > 0) {
            let blockMint, successMint, hashMint, feeMint;
            // if (chunkCount > 3) {
            ({ block: blockMint, success: successMint, hash: hashMint, fee: feeMint } = await sendBatchTransactions(mintRemarks));
            if (!successMint) {
                logger.info(`Failure minting default NFTs at block ${blockMint}: ${successMint} for a total fee of ${feeMint}`)
                return;
            }
            logger.info(`Default NFTs minted at block ${blockMint}: ${successMint} for a total fee of ${feeMint}`)
            while ((await params.remarkBlockCountAdapter.get()) < blockMint) {
                await sleep(3000);
            }
            // add res to nft
            count = 0;
            const addResRemarks: string[] = [];
            for (const [index, vote] of chunk.entries()) {
                const nftProps: INftProps = {
                    block: blockMint,
                    sn: ('00000000' + ((chunkCount * chunkSizeDefault) + count++).toString()).slice(-8),
                    owner: encodeAddress(params.account.address, params.settings.network.prefix),
                    transferable: 1,
                    metadata: usedMetadataCidsDefault[index],
                    collection: itemCollectionId,
                    symbol: referendumIndex.toString() + settings.default.symbol,
                };
                const nft = new NFT(nftProps);
                for (let i = 0; i < settings.default.resources.length; i++) {
                    let resource = settings.default.resources[i]
                    let mainCid = resourceCidsDefault[i][0]
                    let thumbCid = resourceCidsDefault[i][1]
                    if (params.settings.isTest && (vote.accountId.toString() === "FF4KRpru9a1r2nfWeLmZRk6N8z165btsWYaWvqaVgR6qVic"
                        || vote.accountId.toString() === "D3iNikJw3cPq6SasyQCy3k4Y77ZeecgdweTWoSegomHznG3"
                        || vote.accountId.toString() === "HWP8QiZRs3tVbHUFJwA4NANgCx2HbbSSsevgJWhHJaGNLeV"
                        || vote.accountId.toString() === "D2v2HoA6Kgd4czRT3Yo1uUq6XYntAk81GuYpCgVNjmZaETK")) {
                        addResRemarks.push(
                            (resource.slot) ?
                                nft.resadd({
                                    src: `ipfs://ipfs/${mainCid}`,
                                    thumb: `ipfs://ipfs/${thumbCid}`,
                                    id: nanoid(16),
                                    slot: `${resource.slot}`,
                                    metadata: resourceMetadataCidsDefault[i]
                                }) : nft.resadd({
                                    src: `ipfs://ipfs/${mainCid}`,
                                    thumb: `ipfs://ipfs/${thumbCid}`,
                                    id: nanoid(16),
                                    metadata: resourceMetadataCidsDefault[i]
                                })
                        );
                    }
                    else if (!params.settings.isTest) {
                        addResRemarks.push(
                            (resource.slot) ?
                                nft.resadd({
                                    src: `ipfs://ipfs/${mainCid}`,
                                    thumb: `ipfs://ipfs/${thumbCid}`,
                                    id: nanoid(16),
                                    slot: `${resource.slot}`,
                                    metadata: resourceMetadataCidsDefault[i]
                                }) : nft.resadd({
                                    src: `ipfs://ipfs/${mainCid}`,
                                    thumb: `ipfs://ipfs/${thumbCid}`,
                                    id: nanoid(16),
                                    metadata: resourceMetadataCidsDefault[i]
                                })
                        );
                    }
                }
            }

            logger.info("addResRemarks: ", JSON.stringify(addResRemarks))
            const { block: resAddBlock, success: resAddSuccess, hash: resAddHash, fee: resAddFee } = await sendBatchTransactions(addResRemarks);
            logger.info(`Resource(s) added to default NFTs at block ${resAddBlock}: ${resAddSuccess} for a total fee of ${resAddFee}`)
            while ((await params.remarkBlockCountAdapter.get()) < resAddBlock) {
                await sleep(3000);
            }
            if (chunkCount == 0) {
                await sleep(300000);
            }
            // }

            // if (chunkCount > 2) {
            count = 0;
            const sendRemarks: string[] = [];
            for (const [index, vote] of chunk.entries()) {


                // block: chunkCount == 3 ? 12007826 : blockMint,
                const nftProps: INftProps = {
                    block: blockMint,
                    sn: ('00000000' + ((chunkCount * chunkSizeDefault) + count++).toString()).slice(-8),
                    owner: encodeAddress(params.account.address, params.settings.network.prefix),
                    transferable: 1, //parseInt(selectedOption.transferable)
                    metadata: usedMetadataCidsDefault[index],
                    collection: itemCollectionId,
                    symbol: referendumIndex.toString() + settings.default.symbol,
                };
                const nft = new NFT(nftProps);
                //get the parent nft
                let allNFTs = await params.remarkStorageAdapter.getNFTsByCollection(shelfCollectionId);

                const accountShelfNFTId = allNFTs.find(({ owner, rootowner, symbol, burned }) => {
                    return rootowner === vote.accountId.toString() &&
                        symbol === params.settings.shelfNFTSymbol &&
                        burned === ""
                })

                if (!accountShelfNFTId) {
                    logger.info(`couldn't find parent for rootowner: ${vote.accountId.toString()}`)
                }

                if (params.settings.isTest && (vote.accountId.toString() === "FF4KRpru9a1r2nfWeLmZRk6N8z165btsWYaWvqaVgR6qVic"
                    || vote.accountId.toString() === "D3iNikJw3cPq6SasyQCy3k4Y77ZeecgdweTWoSegomHznG3"
                    || vote.accountId.toString() === "HWP8QiZRs3tVbHUFJwA4NANgCx2HbbSSsevgJWhHJaGNLeV"
                    || vote.accountId.toString() === "D2v2HoA6Kgd4czRT3Yo1uUq6XYntAk81GuYpCgVNjmZaETK")) {
                    sendRemarks.push(nft.send(accountShelfNFTId.id.toString()))
                }
                else if (!params.settings.isTest) {
                    sendRemarks.push(nft.send(vote.accountId.toString()))
                }
            }
            // put this for testing
            logger.info("sendRemarks: ", JSON.stringify(sendRemarks))
            //split remarks into sets of 100?
            const { block: sendBlock, success: sendSuccess, hash: sendHash, fee: sendFee } = await sendBatchTransactions(sendRemarks);
            logger.info(`Default NFTs sent at block ${sendBlock}: ${sendSuccess} for a total fee of ${sendFee}`)
            while ((await params.remarkBlockCountAdapter.get()) < sendBlock) {
                await sleep(3000);
            }
            // }
        }
        chunkCount++;
    }




    const metadataCids = []
    for (const option of settings.options) {
        const rarityAttribute: IAttribute = {
            type: "string",
            value: option.rarity,
        }
        const supplyAttribute: IAttribute = {
            type: "number",
            value: uniqs[settings.options.indexOf(option).toString()],
        }
        const artistAttribute: IAttribute = {
            type: "string",
            value: option.artist,
        }
        const creativeDirectorAttribute: IAttribute = {
            type: "string",
            value: option.creativeDirector,
        }
        const refIndexAttribute: IAttribute = {
            type: "string",
            value: referendumIndex.toString(),
        }
        const nameAttribute: IAttribute = {
            type: "string",
            value: option.itemName,
        }
        const typeOfVoteDirectAttribute: IAttribute = {
            type: "string",
            value: "direct",
        }

        const typeOfVoteDelegatedAttribute: IAttribute = {
            type: "string",
            value: "delegated",
        }

        const metadataCidDirect = await pinSingleMetadataWithoutFile(
            `Referendum ${referendumIndex}`,
            {
                description: option.text,
                properties: {
                    "rarity": {
                        ...rarityAttribute
                    },
                    "total_supply": {
                        ...supplyAttribute
                    },
                    "artist": {
                        ...artistAttribute
                    },
                    "creative_director": {
                        ...creativeDirectorAttribute
                    },
                    "referendum_index": {
                        ...refIndexAttribute
                    },
                    "name": {
                        ...nameAttribute
                    },
                    "type_of_vote": {
                        ...typeOfVoteDirectAttribute
                    }
                }
            }
        );

        const metadataCidDelegated = await pinSingleMetadataWithoutFile(
            `Referendum ${referendumIndex}`,
            {
                description: option.text,
                properties: {
                    "rarity": {
                        ...rarityAttribute
                    },
                    "total_supply": {
                        ...supplyAttribute
                    },
                    "artist": {
                        ...artistAttribute
                    },
                    "creative_director": {
                        ...creativeDirectorAttribute
                    },
                    "referendum_index": {
                        ...refIndexAttribute
                    },
                    "name": {
                        ...nameAttribute
                    },
                    "type_of_vote": {
                        ...typeOfVoteDelegatedAttribute
                    }
                }
            }
        );

        if (!metadataCidDirect || !metadataCidDelegated) {
            logger.error(`one of metadataCids is null: dir: ${metadataCidDirect} del: ${metadataCidDelegated}. exiting.`)
            return;
        }

        metadataCids.push([metadataCidDirect, metadataCidDelegated])
        // weights.push(option.probability)
    }
    logger.info("metadataCids", metadataCids);

    chunkCount = 0

    let resourceCids = []
    for (const option of settings.options) {
        let optionResourceCids = []
        for (let i = 0; i < option.resources.length; i++) {
            const resource = option.resources[i]
            let mainCid = await pinSingleFileFromDir("/assets/shelf/referenda",
                resource.main,
                resource.name)
            let thumbCid = await pinSingleFileFromDir("/assets/shelf/referenda",
                resource.thumb,
                resource.name + "_thumb")
            optionResourceCids.push([mainCid, thumbCid])
        }
        resourceCids.push(optionResourceCids)
    }

    logger.info("resourceCids", resourceCids);

    let resourceMetadataCids = []
    for (const option of settings.options) {
        let optionResourceMetadataCids = []
        for (let i = 0; i < option.resources.length; i++) {
            const resource = option.resources[i]
            const rarityAttribute: IAttribute = {
                type: "string",
                value: resource.rarity,
            }
            const supplyAttribute: IAttribute = {
                type: "number",
                value: uniqs[settings.options.indexOf(option).toString()],
            }
            const artistAttribute: IAttribute = {
                type: "string",
                value: resource.artist,
            }
            const creativeDirectorAttribute: IAttribute = {
                type: "string",
                value: resource.creativeDirector,
            }
            const refIndexAttribute: IAttribute = {
                type: "string",
                value: referendumIndex.toString(),
            }
            const nameAttribute: IAttribute = {
                type: "string",
                value: resource.itemName,
            }
            const metadataResource = await pinSingleMetadataWithoutFile(
                `Referendum ${referendumIndex}`,
                {
                    description: resource.text,
                    properties: {
                        "rarity": {
                            ...rarityAttribute
                        },
                        "total_supply": {
                            ...supplyAttribute
                        },
                        "artist": {
                            ...artistAttribute
                        },
                        "creative_director": {
                            ...creativeDirectorAttribute
                        },
                        "referendum_index": {
                            ...refIndexAttribute
                        },
                        "name": {
                            ...nameAttribute
                        }
                    }
                }
            );
            optionResourceMetadataCids.push(metadataResource)
        }
        resourceMetadataCids.push(optionResourceMetadataCids)
    }

    logger.info("resourceMetadataCids", resourceMetadataCids);


    for (let i = 0; i < filteredVotes.length; i += chunkSize) {
        const chunk = filteredVotes.slice(i, i + chunkSize);
        logger.info(`Chunk ${chunkCount}: ${chunk.length}`)
        const mintRemarks: string[] = [];
        let usedMetadataCids: string[] = [];
        let usedResourceMetadataCids: string[] = [];
        let selectedOptions = [];
        let count = 0;

        for (let j = 0; j < chunk.length; j++) {
            const vote = chunk[j]
            const selectedOption = settings.options[selectedIndexArray[i + j]];
            selectedOptions.push(selectedOption);
            const selectedMetadata = metadataCids[selectedIndexArray[i + j]];

            let metadataCid = vote.isDelegating ? selectedMetadata[1] : selectedMetadata[0]

            const randRoyaltyInRange = Math.floor(Math.random() * (selectedOption.royalty[1] - selectedOption.royalty[0] + 1) + selectedOption.royalty[0])
            const itemRoyaltyProperty: IRoyaltyAttribute = {
                type: "royalty",
                value: {
                    receiver: encodeAddress(params.account.address, params.settings.network.prefix),
                    royaltyPercentFloat: randRoyaltyInRange
                }
            }
            if (!metadataCid) {
                logger.error(`metadataCid is null. exiting.`)
                return;
            }
            const nftProps: INftProps = {
                block: 0,
                sn: ('00000000' + (votesNotMeetingRequirements.length + (chunkCount * chunkSize) + count++).toString()).slice(-8),
                owner: encodeAddress(params.account.address, params.settings.network.prefix),
                transferable: 1, //parseInt(selectedOption.transferable)
                metadata: metadataCid,
                collection: itemCollectionId,
                symbol: referendumIndex.toString() + selectedOption.symbol,
                properties: {
                    royaltyInfo: {
                        ...itemRoyaltyProperty
                    }
                },
            };
            usedMetadataCids.push(metadataCid);
            usedResourceMetadataCids.push(resourceMetadataCids[selectedIndexArray[i + j]])
            const nft = new NFT(nftProps);
            if (params.settings.isTest && (vote.accountId.toString() === "FF4KRpru9a1r2nfWeLmZRk6N8z165btsWYaWvqaVgR6qVic"
                || vote.accountId.toString() === "D3iNikJw3cPq6SasyQCy3k4Y77ZeecgdweTWoSegomHznG3"
                || vote.accountId.toString() === "HWP8QiZRs3tVbHUFJwA4NANgCx2HbbSSsevgJWhHJaGNLeV"
                || vote.accountId.toString() === "D2v2HoA6Kgd4czRT3Yo1uUq6XYntAk81GuYpCgVNjmZaETK")) {
                mintRemarks.push(nft.mint());
            }
            else if (!params.settings.isTest) {
                mintRemarks.push(nft.mint());
            }
        }
        logger.info("mintRemarks: ", JSON.stringify(mintRemarks))
        //mint
        if (mintRemarks.length > 0) {
            let blockMint, successMint, hashMint, feeMint;
            // if (chunkCount > 7) {
            ({ block: blockMint, success: successMint, hash: hashMint, fee: feeMint } = await sendBatchTransactions(mintRemarks));
            if (!successMint) {
                logger.info(`Failure minting NFTs at block ${blockMint}: ${successMint} for a total fee of ${feeMint}`)
                return;
            }
            logger.info(`NFTs minted at block ${blockMint}: ${successMint} for a total fee of ${feeMint}`)
            while ((await params.remarkBlockCountAdapter.get()) < blockMint) {
                await sleep(3000);
            }
            // }
            // if (chunkCount > 7) {
            // add res to nft
            count = 0;
            const addResRemarks: string[] = [];
            for (const [index, vote] of chunk.entries()) {

                // block: chunkCount == 7 ? 12421221 : blockMint,
                const selectedOption = selectedOptions[index]
                const nftProps: INftProps = {
                    block: blockMint,
                    sn: ('00000000' + (votesNotMeetingRequirements.length + (chunkCount * chunkSize) + count++).toString()).slice(-8),
                    owner: encodeAddress(params.account.address, params.settings.network.prefix),
                    transferable: 1, //parseInt(selectedOption.transferable)
                    metadata: usedMetadataCids[index],
                    collection: itemCollectionId,
                    symbol: referendumIndex.toString() + selectedOption.symbol,
                };
                const nft = new NFT(nftProps);
                for (let i = 0; i < selectedOption.resources.length; i++) {
                    let resource = selectedOption.resources[i]
                    let mainCid = resourceCids[settings.options.indexOf(selectedOption)][i][0]
                    let thumbCid = resourceCids[settings.options.indexOf(selectedOption)][i][1]
                    if (params.settings.isTest && (vote.accountId.toString() === "FF4KRpru9a1r2nfWeLmZRk6N8z165btsWYaWvqaVgR6qVic"
                        || vote.accountId.toString() === "D3iNikJw3cPq6SasyQCy3k4Y77ZeecgdweTWoSegomHznG3"
                        || vote.accountId.toString() === "HWP8QiZRs3tVbHUFJwA4NANgCx2HbbSSsevgJWhHJaGNLeV"
                        || vote.accountId.toString() === "D2v2HoA6Kgd4czRT3Yo1uUq6XYntAk81GuYpCgVNjmZaETK")) {
                        addResRemarks.push(
                            (resource.slot) ?
                                nft.resadd({
                                    src: `ipfs://ipfs/${mainCid}`,
                                    thumb: `ipfs://ipfs/${thumbCid}`,
                                    id: nanoid(16),
                                    slot: `${resource.slot}`,
                                    metadata: usedResourceMetadataCids[index][i]
                                }) : nft.resadd({
                                    src: `ipfs://ipfs/${mainCid}`,
                                    thumb: `ipfs://ipfs/${thumbCid}`,
                                    id: nanoid(16),
                                    metadata: usedResourceMetadataCids[index][i]
                                })
                        );
                    }
                    else if (!params.settings.isTest) {
                        addResRemarks.push(
                            (resource.slot) ?
                                nft.resadd({
                                    src: `ipfs://ipfs/${mainCid}`,
                                    thumb: `ipfs://ipfs/${thumbCid}`,
                                    id: nanoid(16),
                                    slot: `${resource.slot}`,
                                    metadata: usedResourceMetadataCids[index][i]
                                }) : nft.resadd({
                                    src: `ipfs://ipfs/${mainCid}`,
                                    thumb: `ipfs://ipfs/${thumbCid}`,
                                    id: nanoid(16),
                                    metadata: usedResourceMetadataCids[index][i]
                                })
                        );
                    }
                }
            }
            logger.info("addResRemarks: ", JSON.stringify(addResRemarks))
            const { block: resAddBlock, success: resAddSuccess, hash: resAddHash, fee: resAddFee } = await sendBatchTransactions(addResRemarks);
            logger.info(`Resource(s) added to NFTs at block ${resAddBlock}: ${resAddSuccess} for a total fee of ${resAddFee}`)
            while ((await params.remarkBlockCountAdapter.get()) < resAddBlock) {
                await sleep(3000);
            }
            if (chunkCount == 0) {
                await sleep(300000);
            }
            // }

            // if (chunkCount > 6) {
            count = 0;
            const sendRemarks: string[] = [];
            for (const [index, vote] of chunk.entries()) {

                const selectedOption = selectedOptions[index]
                // block: chunkCount == 7 ? 12421221 : blockMint,
                const nftProps: INftProps = {
                    block: blockMint,
                    sn: ('00000000' + (votesNotMeetingRequirements.length + (chunkCount * chunkSize) + count++).toString()).slice(-8),
                    owner: encodeAddress(params.account.address, params.settings.network.prefix),
                    transferable: 1, //parseInt(selectedOption.transferable)
                    metadata: usedMetadataCids[index],
                    collection: itemCollectionId,
                    symbol: referendumIndex.toString() + selectedOption.symbol,
                };
                const nft = new NFT(nftProps);
                //get the parent nft
                let allNFTs = await params.remarkStorageAdapter.getNFTsByCollection(shelfCollectionId);

                const accountShelfNFTId = allNFTs.find(({ owner, rootowner, symbol, burned }) => {
                    return rootowner === vote.accountId.toString() &&
                        symbol === params.settings.shelfNFTSymbol &&
                        burned === ""
                })

                if (!accountShelfNFTId) {
                    logger.info(`couldn't find parent for rootowner: ${vote.accountId.toString()}`)
                }
                if (params.settings.isTest && (vote.accountId.toString() === "FF4KRpru9a1r2nfWeLmZRk6N8z165btsWYaWvqaVgR6qVic"
                    || vote.accountId.toString() === "D3iNikJw3cPq6SasyQCy3k4Y77ZeecgdweTWoSegomHznG3"
                    || vote.accountId.toString() === "HWP8QiZRs3tVbHUFJwA4NANgCx2HbbSSsevgJWhHJaGNLeV"
                    || vote.accountId.toString() === "D2v2HoA6Kgd4czRT3Yo1uUq6XYntAk81GuYpCgVNjmZaETK")) {
                    sendRemarks.push(nft.send(accountShelfNFTId.id.toString()))
                }
                else if (!params.settings.isTest) {
                    sendRemarks.push(nft.send(vote.accountId.toString()))
                }
            }
            logger.info("sendRemarks: ", JSON.stringify(sendRemarks))
            const { block: sendBlock, success: sendSuccess, hash: sendHash, fee: sendFee } = await sendBatchTransactions(sendRemarks);
            logger.info(`NFTs sent at block ${sendBlock}: ${sendSuccess} for a total fee of ${sendFee}`)
            while ((await params.remarkBlockCountAdapter.get()) < sendBlock) {
                await sleep(3000);
            }
            // }
        }
        chunkCount++;
    }

    //equip new collection to base
    //get base
    const bases = await params.remarkStorageAdapter.getAllBases();
    const base: BaseConsolidated = bases.find(({ issuer, symbol }) => {
        return issuer === encodeAddress(params.account.address, params.settings.network.prefix).toString() &&
            symbol === params.settings.baseSymbol
    })
    logger.info("baseId: ", base.id)
    const baseConsolidated = new Base(
        base.block,
        base.symbol,
        base.issuer,
        base.type,
        base.parts,
        base.themes,
        base.metadata
    )
    const baseEquippableRemarks = [];
    if (settings.createNewCollection) {
        for (const slot of settings.makeEquippable) {
            baseEquippableRemarks.push(baseConsolidated.equippable({ slot: slot, collections: [itemCollectionId], operator: "+" }))
        }
        logger.info("baseEquippableRemarks: ", JSON.stringify(baseEquippableRemarks))
        const { block: equippableBlock, success: equippableSuccess, hash: equippableHash, fee: equippableFee } = await sendBatchTransactions(baseEquippableRemarks);
        logger.info(`Collection whitelisted at block ${equippableBlock}: ${equippableSuccess} for a total fee of ${equippableFee}`)
        while ((await params.remarkBlockCountAdapter.get()) < equippableBlock) {
            await sleep(3000);
        }
    }
    let luckAndSettingsRemarks = []
    logger.info("Writing Luck and Settings to Chain")
    //write luckArray to chain
    luckAndSettingsRemarks.push('PROOFOFCHAOS::' + referendumIndex.toString() + '::LUCK::' + JSON.stringify(luckArray))
    //write settings to chain
    luckAndSettingsRemarks.push('PROOFOFCHAOS::' + referendumIndex.toString() + '::SETTINGS::' + JSON.stringify(settings))
    logger.info("luckAndSettingsRemarks: ", JSON.stringify(luckAndSettingsRemarks))
    const { block: writtenBlock, success: writtenSuccess, hash: writtenHash, fee: writtenFee } = await sendBatchTransactions(luckAndSettingsRemarks);
    logger.info(`Luck and Settings written to chain at block ${writtenBlock}: ${writtenSuccess} for a total fee of ${writtenFee}`)

    logger.info(`Sendout complete for Referendum ${referendumIndex}`);
}