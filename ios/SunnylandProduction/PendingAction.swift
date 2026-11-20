import Foundation

extension API {
    private var pendingURL: URL { FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("SunnylandPending.json") }
    func savePending(_ payload:[String:Any], key:String) throws {
        let record:[String:Any] = ["payload":payload,"key":key,"user":user?.id ?? "","server":base]
        let bytes=try JSONSerialization.data(withJSONObject:record,options:[.sortedKeys])
        if FileManager.default.fileExists(atPath:pendingURL.path) {let prior=try Data(contentsOf:pendingURL);guard prior==bytes else {throw AppError("Recover the unfinished action from Account before saving a different action.")};return}
        try FileManager.default.createDirectory(at:pendingURL.deletingLastPathComponent(),withIntermediateDirectories:true)
        try bytes.write(to:pendingURL,options:[.atomic,.completeFileProtection])
        var url=pendingURL;var values=URLResourceValues();values.isExcludedFromBackup=true;try url.setResourceValues(values)
    }
    func clearPending(){try? FileManager.default.removeItem(at:pendingURL)}
    func recoverPending() async throws {
        guard FileManager.default.fileExists(atPath:pendingURL.path) else {return}
        let bytes=try Data(contentsOf:pendingURL)
        guard let r=try JSONSerialization.jsonObject(with:bytes) as? [String:Any],let payload=r["payload"] as? [String:Any],let key=r["key"] as? String else {throw AppError("The unfinished action record cannot be read. Ask the manager to reconcile the job before taking more stock.")}
        guard r["user"] as? String == user?.id,r["server"] as? String == base else {throw AppError("An unfinished action belongs to another sign-in or server. Sign back into that account to reconcile it.")}
        do {_ = try await request("/api/action",body:payload,key:key);clearPending()}
        catch {if let e=error as? AppError,let status=e.status,[400,403,404].contains(status) {clearPending()};throw error}
    }
}
