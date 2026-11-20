import SwiftUI
import AVKit
import Vision
import UIKit
import UniformTypeIdentifiers

struct Row: Identifiable {
    let values: [String: Any]
    var id: String { text("id").isEmpty ? text("lot") : text("id") }
    func text(_ key: String) -> String { values[key] as? String ?? "" }
    func number(_ key: String) -> Int { values[key] as? Int ?? 0 }
    func flag(_ key: String) -> Bool { values[key] as? Bool ?? false }
    func rows(_ key: String) -> [Row] { (values[key] as? [[String: Any]] ?? []).map { Row(values: $0) } }
}

@MainActor final class API: ObservableObject {
    @Published var token = ""
    @Published var user: Row?
    @Published var jobs: [Row] = []
    @Published var stock: [Row] = []
    @Published var lots: [Row] = []
    @Published var samples: [Row] = []
    @Published var operations: [Row] = []
    @Published var holds: [Row] = []
    @Published var issues: [Row] = []
    @Published var cutrules: [Row] = []
    @Published var users: [Row] = []
    @Published var error: String?
    @Published var working = false
    @AppStorage("server") var base = ""
    func request(_ path: String, body: [String: Any]? = nil, key: String? = nil, raw: Data? = nil, mime: String? = nil) async throws -> Any {
        guard let url = URL(string: base + path), url.scheme == "https", url.user == nil, url.password == nil else { throw AppError("Enter the Sunnyland HTTPS server address.") }
        var req = URLRequest(url: url); req.timeoutInterval = 120
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { req.httpMethod = "POST"; req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]); req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let raw { req.httpMethod = "POST"; req.httpBody = raw; req.setValue(mime, forHTTPHeaderField: "Content-Type") }
        if let key { req.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        let (data, response) = try await URLSession.shared.data(for: req)
        let value = (try? JSONSerialization.jsonObject(with: data)) ?? [:]
        guard let r = response as? HTTPURLResponse, (200..<300).contains(r.statusCode) else { throw AppError((value as? [String: Any])?["error"] as? String ?? "The server could not confirm this action.", status: (response as? HTTPURLResponse)?.statusCode) }
        return value
    }
    func run(_ work: @escaping () async throws -> Void) {
        guard !working else { return }; working = true
        Task { do { try await work() } catch { self.error = error.localizedDescription }; working = false }
    }
    func refresh() async throws {
        let raw = try await request("/api/state")
        guard let map = raw as? [String: Any] else { throw AppError("Unexpected server response.") }
        let row = Row(values: map); jobs = row.rows("jobs"); stock = row.rows("stock"); lots = row.rows("lots"); samples = row.rows("samples"); operations = row.rows("operations"); holds = row.rows("holds"); issues = row.rows("issues"); cutrules = row.rows("cutrules"); users = row.rows("users")
    }
    func action(_ type: String, _ data: [String: Any], key: String) async throws -> Row {
        let payload: [String:Any] = ["type":type,"data":data]
        try savePending(payload, key:key)
        let raw: Any
        do { raw = try await request("/api/action", body:payload, key:key); clearPending() }
        catch { if let e=error as? AppError,let status=e.status,[400,403,404].contains(status) {clearPending()};throw error }
        guard let map = raw as? [String: Any] else { throw AppError("Unexpected server response.") }
        try await refresh(); return Row(values: map)
    }
    func media(_ id: String) async throws -> URL {
        guard let url = URL(string: base + "/api/media/" + id), url.scheme == "https" else { throw AppError("Check server address.") }
        var req = URLRequest(url: url); req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data,response) = try await URLSession.shared.data(for: req)
        guard let r = response as? HTTPURLResponse, r.statusCode == 200 else { throw AppError("Media is not available.") }
        let ext = r.mimeType?.hasPrefix("video/") == true ? "mov" : "jpg"
        let local = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "." + ext)
        try data.write(to: local, options: [.atomic, .completeFileProtection]); return local
    }
}
struct AppError: LocalizedError { let message: String; let status: Int?; init(_ m: String, status: Int? = nil) { message = m; self.status = status }; var errorDescription: String? { message } }

@main struct SunnylandProductionApp: App {
    @StateObject var api = API()
    var body: some Scene { WindowGroup { RootView().environmentObject(api).tint(Color(red: 0.08, green: 0.30, blue: 0.25)) } }
}
struct RootView: View {
    @EnvironmentObject var api: API
    @State private var email = ""
    @State private var password = ""
    var body: some View {
        Group {
            if api.token.isEmpty {
                NavigationStack { Form {
                    Section { Text("Sunnyland Production").font(.title2.bold()); Text("Stock, jobs and approved samples.") }
                    Section("Staff sign-in") {
                        TextField("HTTPS server address", text: $api.base).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        TextField("Email", text: $email).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.emailAddress)
                        SecureField("Password", text: $password)
                        Button("Sign in") { api.run {
                            let response = try await api.request("/api/login", body: ["email":email,"password":password]) as? [String:Any] ?? [:]
                            api.token = response["token"] as? String ?? ""; api.user = Row(values: response["user"] as? [String:Any] ?? [:]); password = ""; try await api.recoverPending(); try await api.refresh()
                        }}.disabled(api.working)
                    }
                }.navigationTitle("Welcome") }
            } else {
                TabView {
                    NavigationStack { StockList() }.tabItem { Label("Stock", systemImage:"barcode.viewfinder") }
                    NavigationStack { JobList() }.tabItem { Label("Jobs", systemImage:"list.clipboard") }
                    NavigationStack { SampleList() }.tabItem { Label("Samples", systemImage:"checkmark.seal") }
                    NavigationStack { Form { Text(api.user?.text("name") ?? ""); Button("Refresh / recover unfinished action") { api.run { try await api.recoverPending(); try await api.refresh() } }; if api.user?.text("role")=="manager" { NavigationLink("Feedback & mail status") { DeliveryStatus() } }; Button("Sign out") { api.run { _ = try await api.request("/api/logout",body:[:]); api.token = ""; api.user = nil; api.jobs=[];api.stock=[];api.lots=[];api.samples=[];api.operations=[];api.holds=[];api.issues=[];api.cutrules=[];api.users=[] } }; Text("Pilot 0.1 · Balances cover recorded lots. Check all locations before treating a count as complete.").font(.footnote) }.navigationTitle("Account") }.tabItem { Label("Account", systemImage:"person.crop.circle") }
                }
            }
        }.alert("Sunnyland", isPresented: Binding(get: { api.error != nil }, set: { if !$0 { api.error=nil } })) { Button("OK") { api.error=nil } } message: { Text(api.error ?? "") }
    }
}
struct StockList: View {
    @EnvironmentObject var api: API
    @State private var query = ""
    @State private var scan = false
    @State private var selected: Row?
    var results: [Row] { api.stock.filter { query.isEmpty || ($0.id + " " + $0.text("name") + " " + $0.text("supplier_ref")).localizedCaseInsensitiveContains(query) } }
    var body: some View {
        List {
            Button { scan=true } label: { Label("Scan stock label", systemImage:"camera") }
            ForEach(results.prefix(80)) { item in NavigationLink { StockDetail(item:item) } label: { VStack(alignment:.leading) { Text(item.text("name")); Text(item.id + " · " + String(item.number("w")) + " × " + String(item.number("h")) + " mm").font(.caption) } } }
            if results.count>80 { Text("Refine the search to find more stock.").font(.footnote) }
        }.searchable(text:$query).navigationTitle("Stock")
            .sheet(isPresented:$scan) { Capture(mode:.barcode) { data,mime in
                scan=false
                api.run {
                    let codes=try detectBarcodes(data)
                    guard codes.count==1, let code=codes.first else { throw AppError(codes.isEmpty ? "No barcode was decoded. Try a closer photo." : "Different barcodes were found. Frame one stock code and try again.") }
                    let raw=try await api.request("/api/resolve?code=" + (code.addingPercentEncoding(withAllowedCharacters:.urlQueryAllowed.subtracting(CharacterSet(charactersIn:"+&=#?"))) ?? "")) as? [String:Any] ?? [:]
                    let rows=Row(values:raw).rows("matches"); if rows.count==1 { selected=rows[0] } else { query=code; throw AppError(rows.isEmpty ? "This label is not linked. Search the catalogue by stock name or code." : "This code matches several sizes. Select the exact size.") }
                }
            }}.sheet(item:$selected) { item in NavigationStack { StockDetail(item:item).toolbar { Button("Done") { selected=nil } } } }
            .refreshable { try? await api.refresh() }
    }
}
func detectBarcodes(_ data: Data) throws -> Set<String> {
    let request=VNDetectBarcodesRequest()
    try VNImageRequestHandler(data:data).perform([request])
    let found=request.results ?? []
    guard found.allSatisfy({ $0.payloadStringValue != nil }) else { throw AppError("Some labels could not be decoded. Try again closer.") }
    return Set(found.compactMap(\.payloadStringValue))
}
struct StockDetail: View {
    @EnvironmentObject var api: API
    let item: Row
    @State private var detail: Row?
    @State private var add = false
    var lots: [Row] { api.lots.filter { $0.text("stock")==item.id } }
    var body: some View {
        List {
            Section { Text(item.text("name")).font(.headline); Text(item.id) }
            Section("Recorded physical stock") {
                if let d=detail { if d.values["physical"] is NSNull {Text("Not counted");Text("Ownership quantities and availability are unknown until counted.").font(.footnote)} else {Text("\(d.number("physical")) sheets on hand"); Text("Owned: \(d.number("owned")) · Consignment: \(d.number("consignment"))"); Text("Unknown ownership: \(d.number("unknown"))"); Text("Reserved: \(d.number("reserved")) · Available: \(d.number("available"))"); Text("Unopened flagged consignment pallets: \(d.number("unopenedConsignmentPallets"))"); Text("Updated " + d.text("asOf")).font(.caption) } }
                Text("Totals cover recorded lots. Uncounted locations remain unknown.").font(.footnote)
            }
            NavigationLink("Receive a new delivery") { ReceiptForm(stock:item) };NavigationLink("Record an approved cut") {CutForm(stock:item)};if api.user?.text("role")=="manager" { NavigationLink("Link a barcode to this stock") { AliasForm(stock:item) } };Section("Pallets and lots") { ForEach(lots) { lot in NavigationLink { CountForm(item:item,existing:lot) } label: { VStack(alignment:.leading) { Text(lot.id + " · " + lot.text("location")); Text("\(lot.number("sheets")) sheets · \(lot.text("owner"))"); Text(lot.flag("opened") ? "Opened" : "Unopened").font(.caption) } } }; Button("Count another pallet or lot") { add=true } }
        }.navigationTitle("Stock balance").task { await refresh() }.refreshable { await refresh() }.sheet(isPresented:$add,onDismiss:{ Task { await refresh() } }) { NavigationStack { CountForm(item:item) } }
    }
    func refresh() async { do { detail=Row(values:try await api.request("/api/stock?code="+(item.id.addingPercentEncoding(withAllowedCharacters:.urlQueryAllowed.subtracting(CharacterSet(charactersIn:"+&=#?"))) ?? "")) as? [String:Any] ?? [:]) } catch { api.error=error.localizedDescription } }
}
struct CountForm: View {
    @EnvironmentObject var api: API; @Environment(\.dismiss) var dismiss
    let item: Row; var existing: Row? = nil
    @State private var lot=""; @State private var location=""; @State private var owner="unknown"; @State private var packaging="wrapped"; @State private var opened=false
    @State private var packs="0"; @State private var per=""; @State private var loose="0"; @State private var reason="Physical count"; @State private var requestID=UUID().uuidString
    var body: some View { Form {
        Section { Text(item.text("name")); TextField("Pallet or lot ID",text:$lot).disabled(existing != nil);TextField("Location",text:$location) }
        Picker("Ownership",selection:$owner) { Text("Unknown").tag("unknown");Text("Sunnyland owned").tag("owned");Text("Consignment").tag("consignment") }
        Picker("Packaging",selection:$packaging) { Text("Wrapped packs").tag("wrapped");Text("Flagged pallet").tag("flagged");Text("Loose sheets").tag("loose") }
        Toggle("Opened",isOn:$opened)
        Section("Physical sheets remaining") { TextField("Full packs or flag intervals",text:$packs).keyboardType(.numberPad);TextField("Sheets per pack or interval",text:$per).keyboardType(.numberPad);TextField("Other / loose sheets",text:$loose).keyboardType(.numberPad);TextField("Reason",text:$reason) }
        if owner=="consignment" && packaging=="flagged" { Text(opened ? "Consignment pallet count: 0. Remaining sheets stay in physical stock." : "Count as one unopened consignment pallet if stock remains.").font(.footnote) }
        Button("Save physical count") { api.run { guard let p=Int(packs), let l=Int(loose), p>=0,l>=0, let e=Int(per.isEmpty ? "0":per), e>=0, p==0 || e>0, p<=99999999,e<=99999999,l<=99999999 else { throw AppError("Enter whole quantities and the actual pack/flag size.") };let total=p*e+l;_ = try await api.action("count",["id":lot,"stock":item.id,"location":location,"owner":owner,"packaging":packaging,"opened":opened,"sheets":total,"reason":reason,"revision":existing?.number("revision") ?? 0],key:requestID);dismiss() }}.disabled(api.working)
    }.navigationTitle(existing == nil ? "Count stock":"Recount lot").toolbar { Button("Cancel") { dismiss() } }.onAppear { if let e=existing { lot=e.id;location=e.text("location");owner=e.text("owner");packaging=e.text("packaging");opened=e.flag("opened");loose=String(e.number("sheets")) } } }
}
struct JobList: View {
    @EnvironmentObject var api: API; @State private var query=""
    var body: some View { List(api.jobs.filter { query.isEmpty || ($0.id+" "+$0.text("name")).localizedCaseInsensitiveContains(query) }) { job in NavigationLink { JobDetail(job:job) } label: { VStack(alignment:.leading) { Text(job.id).font(.headline);Text(job.text("name"));Text(job.flag("active") ? "Active":"Inactive").font(.caption) } } }.searchable(text:$query,prompt:"Job number or description").navigationTitle("Jobs").toolbar {if api.user?.text("role")=="manager" {NavigationLink("Add job") {JobSetupForm()}}}.refreshable { try? await api.refresh() } }
}
struct JobDetail: View {
    @EnvironmentObject var api: API;let job: Row
    var body: some View { List {
        Section { Text(job.text("name"));Text("Status checked " + job.text("verifiedAt")).font(.caption);if api.user?.text("role")=="manager" {NavigationLink("Verify current job status") {VerifyJobForm(job:job)}} }
        ForEach(job.rows("sections")) { section in Section(section.text("name")) {
            NavigationLink("Take stock") { IssueForm(job:job,section:section) }
            NavigationLink("Record operation / quality check") { OperationForm(job:job,section:section) }
            NavigationLink("Place section on hold") { HoldForm(job:job,section:section) }
        }}
        Section("Active holds") { ForEach(api.holds.filter { $0.text("job")==job.id && $0.values["releasedAt"] is NSNull }) { h in if api.user?.text("role")=="manager" { NavigationLink { ReleaseForm(hold:h) } label: { Text(h.text("section")+": "+h.text("reason")).foregroundStyle(.red) } } else { Text(h.text("section")+": "+h.text("reason")).foregroundStyle(.red) } } }
        Section("Samples") { NavigationLink("Capture photo or video") { SampleForm(job:job) };ForEach(api.samples.filter { $0.text("job")==job.id }) { s in NavigationLink { SampleDetail(sample:s) } label: { Text(s.text("title")+" · "+s.text("state")) } } }
        Section("Stock issued") { ForEach(api.issues.filter { $0.text("job")==job.id }) { issue in NavigationLink { ReturnForm(issue:issue) } label: { Text("\(issue.number("sheets")) sheets · \(issue.text("stock"))") } } }
    }.navigationTitle(job.id) }
}
struct IssueForm: View {
    @EnvironmentObject var api: API;let job:Row;let section:Row
    @State private var scan=false;@State private var stock="";@State private var amount="";@State private var plan:Row?;@State private var requestID=UUID().uuidString;@State private var saved=false
    var body: some View { Form {
        Text(job.id+" · "+section.text("name"));Picker("Stock",selection:$stock) { Text("Select stock").tag("");ForEach(section.values["stocks"] as? [String] ?? [],id:\.self) { Text($0).tag($0) } }.disabled(plan != nil)
        Button("Scan stock for this job") {scan=true}.disabled(plan != nil);TextField("Sheets taken",text:$amount).keyboardType(.numberPad).disabled(plan != nil)
        if let p=plan { Section("Take these lots — owned first") { ForEach(p.rows("picks")) { v in Text("\(v.text("lot")): \(v.number("sheets")) sheets · \(v.text("owner"))") } }
            Button(saved ? "Stock issue saved":"Confirm stock taken") { api.run { _ = try await api.action("issue",["job":job.id,"section":section.id,"stock":stock,"sheets":Int(amount) ?? 0,"confirmedLots":p.values["picks"] ?? []],key:requestID);saved=true } }.disabled(saved||api.working)
        } else { Button("Show picking plan") { api.run { plan = try await api.action("issue",["job":job.id,"section":section.id,"stock":stock,"sheets":Int(amount) ?? 0,"preview":true],key:UUID().uuidString) } }.disabled(api.working) }
    }.navigationTitle("Take stock").sheet(isPresented:$scan) {Capture(mode:.barcode) {data,_ in scan=false;api.run {let codes=try detectBarcodes(data);guard codes.count==1,let code=codes.first else {throw AppError("Use one stock code in the frame. Identical repeated labels are accepted.")};let encoded=code.addingPercentEncoding(withAllowedCharacters:.urlQueryAllowed.subtracting(CharacterSet(charactersIn:"+&=#?"))) ?? "";let raw=try await api.request("/api/resolve?code="+encoded) as? [String:Any] ?? [:];let matches=Row(values:raw).rows("matches");guard matches.count==1,let item=matches.first else {throw AppError("This barcode needs an exact catalogue link before use.")};guard (section.values["stocks"] as? [String] ?? []).contains(item.id) else {throw AppError("This stock is not approved for this job section.")};stock=item.id}}} }
}
struct ReturnForm:View {
    @EnvironmentObject var api:API;let issue:Row;@State private var lot="";@State private var amount="";@State private var reason="Unused stock";@State private var key=UUID().uuidString;@State private var saved=false
    var body: some View { Form { Text(issue.text("job"));Picker("Original lot",selection:$lot) {Text("Select lot").tag("");ForEach(issue.rows("picks")) { p in Text(p.text("lot")).tag(p.text("lot")) }};TextField("Sheets returned",text:$amount).keyboardType(.numberPad);TextField("Reason",text:$reason);Button(saved ? "Return saved":"Confirm return") {api.run {_ = try await api.action("return",["issue":issue.id,"lot":lot,"sheets":Int(amount) ?? 0,"reason":reason],key:key);saved=true}}.disabled(saved||api.working);NavigationLink("Record waste from this issue") {WasteForm(issue:issue)} }.navigationTitle("Return stock") }
}
struct HoldForm:View {
    @EnvironmentObject var api:API;let job:Row;let section:Row;@State private var reason="";@State private var key=UUID().uuidString;@State private var saved=false
    var body: some View {Form {TextField("Why is this section on hold?",text:$reason,axis:.vertical);Button(saved ? "Hold recorded":"Place on hold",role:.destructive) {api.run {_ = try await api.action("hold",["job":job.id,"section":section.id,"reason":reason],key:key);saved=true}}.disabled(saved||api.working)}.navigationTitle("Hold section")}
}
struct OperationForm:View {
    @EnvironmentObject var api:API;let job:Row;let section:Row;@State private var name="Printing";@State private var location="";@State private var newID=UUID().uuidString;@State private var opID="";@State private var note="";@State private var good="0";@State private var waste="0";@State private var unit="sheets";@State private var key=UUID().uuidString
    var op:Row? {api.operations.first {$0.id==opID}}
    var body:some View {Form {
        Picker("Existing operation",selection:$opID) {Text("New operation").tag(newID);ForEach(api.operations.filter {$0.text("job")==job.id && $0.text("section")==section.id}) {o in Text(o.text("name")+" · "+o.text("state")).tag(o.id)}}
        TextField("Operation",text:$name);TextField("Machine / location",text:$location);TextField("Unit",text:$unit)
        Text(op?.text("state") ?? "Ready")
        if op?.text("state") != "completed" {
            Button(op?.text("state")=="running" ? "Pause":"Start / resume") { change(op?.text("state")=="running" ? "paused":"running") }.disabled(api.working)
            if op != nil {Section("Quality check") {TextField("Checks and observations",text:$note,axis:.vertical);Button("Pass quality check") {check("pass")};Button("Fail and hold section",role:.destructive) {check("fail")}}
                TextField("Good quantity",text:$good).keyboardType(.numberPad);TextField("Waste quantity",text:$waste).keyboardType(.numberPad);Button("Finish operation") {change("completed")}.disabled(api.working)
            }
        }
    }.navigationTitle("Job activity").onAppear {if opID.isEmpty {opID=newID}}.onChange(of:opID) {_,_ in if let o=op {name=o.text("name");location=o.text("location");unit=o.text("unit")};key=UUID().uuidString} }
    func change(_ state:String) {api.run {_ = try await api.action("operation",["id":opID,"job":job.id,"section":section.id,"name":name,"location":location,"unit":unit,"state":state,"revision":op?.number("revision") ?? 0,"good":Int(good) ?? 0,"waste":Int(waste) ?? 0],key:key);key=UUID().uuidString}}
    func check(_ result:String) {api.run {_ = try await api.action("qc",["operation":opID,"result":result,"note":note],key:key);key=UUID().uuidString}}
}
struct SampleForm:View {
    @EnvironmentObject var api:API;let job:Row;var family:String?=nil;@State private var title="Folding sample";@State private var note="";@State private var camera=false;@State private var media:Data?;@State private var mime="";@State private var mediaID="";@State private var key=UUID().uuidString;@State private var saved=false
    var body:some View {Form {Text(job.id);TextField("Sample title",text:$title);TextField("What needs checking?",text:$note,axis:.vertical);Button(media == nil ? "Take photo or video":"Replace capture") {camera=true}.disabled(saved);if let media {Text("Captured \(media.count/1024) KB");Button(saved ? "Submitted for approval":"Submit for approval") {api.run {if mediaID.isEmpty {let raw=try await api.request("/api/media",raw:media,mime:mime) as? [String:Any] ?? [:];mediaID=raw["id"] as? String ?? ""};_ = try await api.action("sample",["job":job.id,"title":title,"note":note,"media":mediaID,"family":(family as Any?) ?? NSNull()],key:key);saved=true}}.disabled(saved||api.working)}}.navigationTitle("Create sample").sheet(isPresented:$camera) {Capture(mode:.sample) {data,type in media=data;mime=type;mediaID="";key=UUID().uuidString;camera=false}}}
}
struct SampleList:View {
    @EnvironmentObject var api:API
    var body:some View {List {ForEach(api.samples.sorted {$0.text("at")>$1.text("at")}) {s in NavigationLink {SampleDetail(sample:s)} label: {VStack(alignment:.leading) {Text(s.text("job")+" · "+s.text("title"));Text("Version \(s.number("version")) · \(s.text("state"))").font(.caption)}}}}.navigationTitle("Samples & approvals").refreshable {try? await api.refresh()}}
}
struct SampleDetail:View {
    @EnvironmentObject var api:API;let sample:Row;@State private var local:URL?;@State private var note="";@State private var key=UUID().uuidString
    var current:Row {api.samples.first {$0.id==sample.id} ?? sample}
    var body:some View {Form {Text(current.text("job")+" · "+current.text("title")).font(.headline);Text("Version \(current.number("version")) · \(current.text("state"))");Text(current.text("note"));if let local {if local.pathExtension=="mov" {VideoPlayer(player:AVPlayer(url:local)).frame(height:300)} else if let image=UIImage(contentsOfFile:local.path) {Image(uiImage:image).resizable().scaledToFit()}}
        if current.text("state")=="pending" && (api.user?.id==current.text("rep") || api.user?.text("role")=="manager") {TextField("Decision notes",text:$note,axis:.vertical);Button("Approve this version") {decide("approved")}.disabled(local==nil||api.working);Button("Request changes") {decide("changes_requested")}.disabled(local==nil||api.working)}
    if api.user?.id==current.text("creator"), let job=api.jobs.first(where: {$0.id==current.text("job")}) { NavigationLink("Capture a replacement version") { SampleForm(job:job,family:current.text("family")) } };if current.flag("newerVersionExists") { Text("A newer version exists. Review its approval status before production.").foregroundStyle(.orange) } }.navigationTitle("Sample review").task {do {local=try await api.media(current.text("media"))}catch{api.error=error.localizedDescription}}.onDisappear {if let local {try? FileManager.default.removeItem(at:local)}}}
    func decide(_ state:String) {api.run {_ = try await api.action("decision",["id":current.id,"state":state,"note":note],key:key)}}
}
struct Capture:UIViewControllerRepresentable {
    enum Mode {case barcode,sample}; let mode:Mode; let completion:(Data,String)->Void
    @Environment(\.dismiss) var dismiss
    func makeCoordinator()->Coordinator {Coordinator(self)}
    func makeUIViewController(context:Context)->UIImagePickerController {let c=UIImagePickerController();c.delegate=context.coordinator;c.sourceType=UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera:.photoLibrary;c.mediaTypes=mode == .barcode ? [UTType.image.identifier]:[UTType.image.identifier,UTType.movie.identifier];c.videoMaximumDuration=120;c.videoQuality = .typeMedium;return c}
    func updateUIViewController(_ uiViewController:UIImagePickerController,context:Context) {}
    class Coordinator:NSObject,UINavigationControllerDelegate,UIImagePickerControllerDelegate {
        let parent:Capture;init(_ p:Capture){parent=p}
        func imagePickerControllerDidCancel(_ picker:UIImagePickerController){parent.dismiss()}
        func imagePickerController(_ picker:UIImagePickerController,didFinishPickingMediaWithInfo info:[UIImagePickerController.InfoKey:Any]) {if let image=info[.originalImage] as? UIImage,let data=image.jpegData(compressionQuality:0.92){parent.completion(data,"image/jpeg")}else if let url=info[.mediaURL] as? URL,let data=try? Data(contentsOf:url){parent.completion(data,"video/quicktime")};parent.dismiss()}
    }
}
