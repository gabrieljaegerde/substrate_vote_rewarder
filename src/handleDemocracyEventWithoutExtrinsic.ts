import { DemocracyEvents, Modules, ReferendumMethods } from "../tools/constants.js";
import { sendNFTs } from "./sendNFTs.js";

const isReferendumEvent = (section, method) => {
    if (
        ![Modules.Democracy].includes(section)
    ) {
        return false;
    }

    return ReferendumMethods.hasOwnProperty(method);
};

export const handleDemocracyEventWithoutExtrinsic = async (
    event,
    indexer // this indexer doesn't have extrinsic index
) => {
    const { section, method } = event;
    if (!isReferendumEvent(section, method)) {
        return;
    }
    console.log("method", method)
    if (ReferendumMethods.Passed === method) {
        console.log("event", event.index.toJSON());
        console.log("data", event.data.toJSON())
        const [id, type] = event.data;
        console.log("id", id)
        sendNFTs(true, id)
        //await saveNewReferendum(event, indexer);
    }
    if (ReferendumMethods.NotPassed === method) {
        const [id, type] = event.data;
        sendNFTs(false, id)
    }
};