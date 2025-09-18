import React from "react";

export function ConnectZohoCard() {
    return (
        <div className="mx-auto mt-24 w-[480px] rounded-2xl bg-[#101826] p-6 shadow-lg">
            <h2 className="mb-2 text-xl font-semibold">Connect Zoho</h2>
            <p className="mb-4 text-sm text-gray-300">
                Please connect your Zoho account to continue.
            </p>
            <a
                href="/api/zoho/connect?returnTo=/time-off"
                className="inline-flex items-center rounded-xl bg-blue-600 px-4 py-2 font-medium hover:bg-blue-500"
            >
                Connect Zoho
            </a>
        </div>
    );
}
