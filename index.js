const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const jwt = require("jsonwebtoken");
require("dotenv").config(); // Load environment variables from .env file
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});
app.use((req, res, next) => {
 
  next();
});


//token genarate from terminal
//step 1: node
//step 2: require('crypto').randomBytes(64).toString('hex')
//step 3: copy token without qoutation and keep it in env file by a variable
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster10.gvxih53.mongodb.net/?retryWrites=true&w=majority&appName=Cluster10`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

function verifyJwt(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "Unauthorized access" });
  }
  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, function (err, decoded) {
    if (err) {
      return res.status(403).send({ message: "Forbidden access" });
    }
    req.decoded = decoded;
    next();
  });
}

async function run() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");

    const servicesCollection = client
      .db(process.env.DB_NAME)
      .collection("services");
    const bookingsCollection = client
      .db(process.env.DB_NAME)
      .collection("bookings");
    const usersCollection = client.db(process.env.DB_NAME).collection("users");
    const doctorsCollection = client
      .db(process.env.DB_NAME)
      .collection("doctors");
    const paymentCollection = client
      .db(process.env.DB_NAME)
      .collection("payments");

    const verifyAdmin = async (req, res, next) => {
      const requester = req.decoded.email;
      const requesterAccount = await usersCollection.findOne({
        email: requester,
      });
      if (requesterAccount.role === "admin") {
        next();
      } else {
        res.status(403).send({ message: "forbidden" });
      }
    };

    // services api
    app.get("/services", async (req, res) => {
      try {
        const services = await servicesCollection
          .find({})
          .project({ name: 1 })
          .toArray();
        res.json(services);
      } catch (error) {
        console.error("Failed to retrieve services:", error);
        res.status(500).send("Error retrieving services");
      }
    });

    app.get("/user", verifyJwt, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    app.get("/admin/:email", async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email: email });
      const isAdmin = user.role === "admin";
      res.send({ admin: isAdmin });
    });

    app.put("/user/admin/:email", verifyJwt, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const updateDoc = { $set: { role: "admin" } };
      const result = await usersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    app.put("/user/:email", async (req, res) => {
      const email = req.params.email;
      const user = req.body;
      const query = { email: email };
      const options = { upsert: true };
      const updateDoc = { $set: user };
      const result = await usersCollection.updateOne(query, updateDoc, options);
      const token = jwt.sign(
        { email: email },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: "5h" }
      );
      res.send({ result, token });
    });

    //available slot for a particular date
    app.get("/available", async (req, res) => {
      const date = req.query.date;
      const services = await servicesCollection.find({}).toArray();
      const query = { date: date };
      const bookings = await bookingsCollection.find(query).toArray();
      services.forEach((service) => {
        const serviceBookings = bookings.filter(
          (booking) => booking.treatment === service.name
        );
        const bookedSlots = serviceBookings.map((s) => s.slot);
        const available = service.slots.filter(
          (slot) => !bookedSlots.includes(slot)
        );
        service.slots = available;
      });
      res.json(services);
    });

    //bookings api
    app.get("/booking", verifyJwt, async (req, res) => {
      const patient = req.query.patient;
      const decodedEmail = req.decoded.email;
      if (patient === decodedEmail) {
        const query = { patient: patient };
        const bookings = await bookingsCollection.find(query).toArray();
        return res.send(bookings);
      } else {
        return res.status(403).send({ message: "Forbidden access" });
      }
    });

    app.get("/booking/:id", verifyJwt, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const booking = await bookingsCollection.findOne(query);
      res.send(booking);
    });

    app.post("/booking", async (req, res) => {
      const booking = req.body;
      const query = {
        treatment: booking.treatment,
        date: booking.date,
        patient: booking.patient,
      };
      const exists = await bookingsCollection.findOne(query);
      if (exists) {
        return res.send({
          success: false,
          message: "Already have a booking",
          booking: exists,
        });
      }
      const result = await bookingsCollection.insertOne(booking);
      return res.send({
        success: true,
        message: "A booking added successfully",
        booking: result,
      });
    });

    app.patch("/booking/:id", verifyJwt, async (req, res) => {
      const id = req.params.id;
      const payment = req.body;
      const filter = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          paid: true,
          transactionId: payment.transactionId,
        },
      };
      const result = await paymentCollection.insertOne(payment);
      const updatedooking = await bookingsCollection.updateOne(
        filter,
        updatedDoc
      );

      res.send(updatedDoc);
    });

    //payment api
    app.post("/create-payment-intent", verifyJwt, async (req, res) => {
      try {
        const { amount } = req.body;

        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: "usd",
        });

        res.status(200).send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    //doctors api
    app.get("/doctor", verifyJwt, verifyAdmin, async (req, res) => {
      const doctors = await doctorsCollection.find().toArray();
      res.send(doctors);
    });

    app.post("/doctor", verifyJwt, verifyAdmin, async (req, res) => {
      const doctor = req.body;
      const result = await doctorsCollection.insertOne(doctor);
      res.send(result);
    });

    app.delete("/doctor/:email", verifyJwt, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const filter = { email: email };
      const result = await doctorsCollection.deleteOne(filter);
      res.send(result);
    });
    // Start the server after the database connection is established in port
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });

    // Define route for GET requests to the root URL "/"
    app.get("/", (req, res) => {
      res.send("My doctor portal is running");
    });
  } catch (error) {
    console.error("Failed to connect to MongoDB", error);
    process.exit(1);
  }
}

run().catch(console.dir);
